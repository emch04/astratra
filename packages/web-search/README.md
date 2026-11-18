# @astratra/web-search

Web search for AI agents, where every fact stays attached to its page.

Several engines (Serper for Google results, Brave Search, Tavily, Exa, or a
search gateway of your own) with automatic fallback; their **rankings** are fused, their
**contents never are**. Each result is one page of one site, with its exact
address, its domain, its date when known, the excerpt of **one** engine for
**that** page, and, when the page is read, passages quoted word for word with
their position. Pages are read without opening a door to your internal network
(SSRF), and everything a model reads from the web is framed as data, not
instructions. An optional, isolated integrated browser reads pages built with
JavaScript, walks a site's links and uses its own search.

[Version française](README.fr.md)

```bash
npm install @astratra/web-search
```

## Why

An assistant that searches on its own usually takes the first engine's top
results and pastes snippets together. Three things go wrong: the right site is
missing because one engine ranked it low, the same page shows up three times
under three addresses, and the answer mixes sentences from different pages
without saying which came from where. This package fixes those three and makes
each one checkable (see [Evaluation](#evaluation)).

## Quick start

```js
const { createWebSearch, braveProvider, tavilyProvider, formatForModel } = require('@astratra/web-search');

// The engines and their order are yours: none is chosen by the package.
const ws = createWebSearch({
  providers: [
    braveProvider({ key: () => process.env.BRAVE_SEARCH_API_KEY }),
    tavilyProvider({ key: () => process.env.TAVILY_API_KEY })
  ]
});

const found = await ws.search({ query: 'tomato watering schedule', lang: 'en', freshness: 'auto', read: 2 });
found.results[0];
// { id: 'S1', title, url, canonicalUrl, domain, publishedAt, dateSource, snippet, snippetFrom: 'gateway',
//   foundBy: ['gateway', 'brave'], ranks: { gateway: 1, brave: 3 }, score,
//   page: { status: 'read', passages: [{ text, start, end }], … } }
found.report;      // engines tried and used, failures, estimated cost, time, cache hits
formatForModel(found);   // the text to give a model: citation rules, then the sources inside a data frame
```

## What it guarantees

- **No content fusion.** Rankings are fused with Reciprocal Rank Fusion
  (`1 / (60 + rank)` per list). The title, snippet and extra snippets of a
  result all come from the single engine that ranked that page best, named in
  `snippetFrom`. Two engines' snippets are never pasted together, even for the
  same page. A date given by another engine for the **same** page is kept, and
  `dateSource` says which engine gave it.
- **One entry = one page = one site.** Results are deduplicated by canonical
  page: host without `www.`, no fragment, no tracking parameters (`utm_*`,
  `gclid`…), sorted parameters, no trailing slash. When pages are read, their
  `<link rel="canonical">` (same site only) merges two addresses of the same page.
  Different pages are never merged, however similar.
- **Passages are verbatim.** `passages[i].text === pageText.slice(start, end)`,
  always. `ws.read(url, { quotes })` says for each quote whether the page
  contains it (`found`, `exact`, position), or `found: false`.
- **A redirect to another site is not that result's page.** Its text is not
  attached (`page.status: 'other_site'`).
- **Filters are checked on arrival.** `sites`, `excludeSites`, blocked domains
  and the freshness window are sent to each engine in its own form, then
  checked again on what comes back.

## Engines

| Provider | Endpoint | Notes |
|---|---|---|
| `gatewayProvider({ search })` | a search gateway of your own: `search({ requete, nombre, langue?, pays?, periode? }, { signal })` returns `{ fournisseur, resultats: [{ titre, url, extrait, date? }] }` | The engine keys stay with your gateway, which counts the cost (`costPerCallUsd: null`). Sites are sent as `site:` operators. |
| `serperProvider({ key })` | `google.serper.dev` | Reuses `searchSerper` of `@astratra/ai`. Country (`gl`), language (`hl`), period (`tbs`). |
| `braveProvider({ key })` | `api.search.brave.com/res/v1/web/search` | Independent index. `extra_snippets` of the same page, `freshness`. Brave reserves storing results to plans that include it: the cache of this engine is 1 minute by default. |
| `tavilyProvider({ key })` | `api.tavily.com/search` | Native domain filters, `time_range`. `search_depth: 'basic'` (1 credit) is set explicitly. The generated `answer` is never requested. |
| `exaProvider({ key })` | `api.exa.ai/search` | Semantic search, `highlights` from the page, `publishedDate`. The cost reported by Exa (`costDollars.total`) is used. The generated `summary` is never requested. |

A key is a string or a function read on every call (rotation without restart).
It is sent in a header, never in an address, and never appears in an error, a
report or a tool output. Your own engine is an object
`{ id, costPerCallUsd, search(request, { signal, now }) => { hits } }`.

## Modes, fallback, cost

- `mode: 'fuse'` (default): the first `fuseCount` (2) available engines answer
  together; an engine that fails is replaced by the next one in the list.
- `mode: 'fallback'`: one engine at a time; the next only if the previous one
  fails or finds nothing (`fallbackOnEmpty`).
- A network failure or a 5xx is retried once (`retry`), with a wait. A 4xx is
  not. A 402 or a 429 puts the engine to rest (`cooldownMs`, 60 s).
- `quotas: { brave: { perMinute, perDay, perMonth } }` (fixed windows; `perMonth`
  is 30 days); `quotaStore` and `cache` take your Redis or database
  (`{ get, incr }`, `{ get, set }`).
- `budgetMs` (25 s) bounds a whole search, page reads included.
- `report.costUsd` is the estimated cost of the calls that went out (cache
  hits cost 0). `costComplete: false` means an engine did not give its cost
  (the gateway counts it on its side).

## Quality

- `freshness: 'day' | 'week' | 'month' | 'year'` is a filter. `'auto'`
  (default) filters nothing, but when the question asks for recent facts
  ("today", "latest", "current", the current year…) recent pages get a bonus
  that decreases with age.
- `site:` and `-site:` written in the query become filters.
- `ranking: { blockDomains, preferDomains (×1.5), demoteDomains (×0.5), domainScore(domain), maxPerDomain (2) }`.
- `rewrite: async (request) => newQuery` plugs in your own query rewriting;
  the filters are kept, and `report.rewrittenQuery` shows what was sent.
- `extract: (html, { url }) => ({ text, title?, publishedAt?, canonical? })`
  plugs in another extractor (Readability…). The built-in one, with no
  dependency, keeps `<article>`, `<main>` or `role="main"` and removes scripts,
  menus, footers, cookie banners, sharing blocks and ads.

## Reading pages safely

`ws.read(url, { quotes, query })` and `search({ read: n })` go through
`safeFetch`:

- https only, port 443 (or `reading.ports`), no credentials in the address;
- the name is resolved **before** connecting and the connection goes to the
  checked address itself (through the `lookup` of `https.request`): DNS
  rebinding gains nothing. If **any** address of the name is internal, the read
  is refused. Refused: loopback, private networks, link-local (including cloud
  metadata, 169.254.169.254), CGNAT, multicast, reserved and documentation
  ranges; in IPv6, everything outside global unicast, IPv4-mapped, NAT64, 6to4,
  Teredo, ULA and link-local. Names such as `localhost`, `*.local` or
  `*.internal` are refused without a lookup;
- redirects are followed by hand, each one checked again, 5 at most;
- one timeout for the whole read; a maximum size counted **after**
  decompression (2 MB; beyond it the page is cut, `truncated: true`);
- only `text/html`, `application/xhtml+xml` and `text/plain`.

## Plugging it into a model

```js
const { toolDefinitions, nativeTools, registryTools } = require('@astratra/web-search');

toolDefinitions('anthropic');   // [{ name: 'web_search', description, input_schema }, { name: 'read_page', … }]
toolDefinitions('openai');      // [{ type: 'function', function: { name, description, parameters } }, …] (also 'mistral')
toolDefinitions('gemini');      // [{ functionDeclarations: [...] }], schema cleaned by geminiSchema of @astratra/ai
```

- **`runToolLoop` of `@astratra/ai`**: `nativeTools(ws)` gives `read` tools with
  `LOW` risk that return `{ data, sources }`. Each source is
  `{ kind: 'web', id, url, title, domain, publishedAt, excerpt }`: it goes into
  `createSourceLedger`, and `kind: 'web'` lets `readsUntrusted` mark the run as
  exposed. The text fits in 5,000 characters, under the 6,000 at which
  `createToolCaller` cuts, so the frame is never cut.
- **`runAgentLoop` of `@astratra/ai`**: `registryTools(ws, { roles })` registers
  `type: 'read'`, `risk: 'LOW'`, `external: true` (the query leaves the
  application: the masker applies to it).
- **MCP**: `createMcpServer(ws)` from `@astratra/web-search/mcp` (protocol from
  `@astratra/mcp`, no dependency) serves the same two tools, marked read-only. A
  ready-made stdio server reads its engines from the environment:

```bash
SERPER_API_KEY=… npx astratra-web-search-mcp
```

  The environment is checked in this order: `SERPER_API_KEY`,
  `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`. Set
  `WEB_SEARCH_MODE=fallback` to use one engine at a time.

What a model reads: citation rules (cite `[S1]`, never attribute one source's
words to another) **outside** the frame; the sources, with their address, site,
date, snippet and verbatim passages, **inside** a frame of untrusted data whose
random marker the page cannot close. The whole text never exceeds `maxChars`.

## Integrated browser (read-only)

A page built with JavaScript (React, Vue…) gives almost nothing to a plain
read. The integrated browser opens it in a real headless Chromium, waits for it
to settle and reads what a person sees. It can also **walk** a site (numbered
links), use **its own search** without clicking or typing, and take a
**screenshot** on request. It changes nothing on the web: no click that sends
anything, no form other than a GET search, no sign-in, no purchase.

```js
const { createWebSearch, createBrowserClient } = require('@astratra/web-search');

const ws = createWebSearch({
  providers: [/* … */],
  browser: createBrowserClient({ baseUrl: 'http://127.0.0.1:5008', tokenFile: '/etc/astratra/browser-token' })
});

await ws.read(url);                              // plain read, then the browser under 200 words
const page = await ws.browse(url, { query });    // rendered text, links [L1]…, passages
await ws.browse(page.links[0].url);              // follow a link
await ws.searchSite('https://docs.python.org/3/', 'asyncio');  // the site's own search
await ws.browse(url, { screenshot: true });      // page.screenshot: PNG, 1280 × 800 at most
```

- `reading.browser`: `'fallback'` (default with a browser: under
  `reading.minWords`, 200 words, the plain read hands over), `'always'` or
  `'never'`. `page.via` says who read it (`fetch` or `browser`).
- Two tools are added when `browser` is given, in `toolDefinitions`
  (`{ browser: true }`), `nativeTools`, `registryTools` and the MCP server:
  `browse_page` `{ url, query?, quotes?, screenshot? }` and `search_site`
  `{ url, query }`. Same rules as `read_page`: https only, text inside the
  untrusted-data frame (links included), sources `kind: 'web'`, risk `LOW`,
  kind `read`, `external: true`.
- Screenshots: only for a model that reads images
  (`nativeTools(ws, { screenshots: true })` returns `images`,
  `createMcpServer(ws, { screenshots: true })` an image content); refused
  otherwise. `registryTools` returns text only.
- `allowDomains: ['example.com']` (option of `createWebSearch`) limits the
  pages read and opened to those sites; `ranking.blockDomains` is refused for
  every read (and for redirects, inside the browser).
- Site search: the site's OpenSearch description, else a `GET` form with a
  single search text field; the results address is computed, then opened, on
  the same site. Search engines (Google, Bing…) are refused: query them through
  their API, with `web_search`.

### The `astratra-web-browser` service

In production, one Chromium runs on the server, shared by every application,
in a separate service shipped with the package. It listens on
`127.0.0.1:5008` (never outside), requires an `Authorization: Bearer` token
read from a file on every request, and serves `POST /v1/open`,
`POST /v1/site-search` and `GET /health`. Each request opens a fresh context
(no cookies, storage or cache), one page, destroyed at the end; two pages at
most at a time (`--max-contexts`), then a bounded wait, then `503 busy`.

Install on a Linux server (Ubuntu 24, as root):

```bash
npm install @astratra/web-search playwright
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx playwright install --with-deps chromium-headless-shell
npx astratra-web-browser setup --out ./browser --node "$(command -v node)" \
  --token-file /etc/astratra/browser-token --browsers-path /opt/ms-playwright
```

`setup` first checks the machine (Linux, systemd, nftables, AppArmor, Node,
Chromium, DNS resolver) and says what is missing, then writes the systemd
unit, the nftables rules and the unit that loads them at boot (leaving the
machine's other rules alone), the AppArmor profile and the steps to follow
(`INSTALL.md` in English, `INSTALL.fr.md` in French). DNS resolvers are read
from `/etc/resolv.conf` (`--dns` to give others).

**The token** is a secret of the machine, which
keeps the server's other programs from using the browser.
`astratra-web-browser token --out /etc/astratra/browser-token --group
astratra-browser` draws it at random (32 bytes) and writes it owned by root,
mode 640, readable by the `astratra-browser` group. Put in that group the user
of each application that calls the service; it reads the token with
`createBrowserClient({ tokenFile })`. To change the token, rewrite the file:
the service and the clients read it again on every request.

For development, `createLocalBrowser()` runs the same engine in-process
(requires `playwright`); it refuses to start when `NODE_ENV=production`,
unless `allowInProduction: true`. Or `astratra-web-browser serve --token-file
… --unsafe-no-firewall` starts the service on a machine without the firewall.

`createBrowserPm2App` exists too, but pm2 gives none of systemd's protections
(own user, read-only system, bounded memory): the firewall stays mandatory,
and pm2 must run as the service user.

### For framework users: which setup to choose

The package depends on no Astratra service: everyone runs **their own**
browser, on **their own** machine, with **their own** token.

| Your hosting | What to do |
|---|---|
| A Linux server of your own (VPS, dedicated) with systemd | The `astratra-web-browser` service, installed by `setup`: the recommended way, the only one with every protection. |
| A Linux server without systemd (pm2 only) | `createBrowserPm2App`, as the service user, with the firewall; fewer protections (no read-only system, no kernel-bounded memory). |
| Hosting without root access or without a server (Vercel, Netlify, functions, Render, Heroku), a container | No browser in production for now: search and `read_page` work without it. The local mode does not replace the service. |
| A development machine (macOS, Windows, Linux) | `createLocalBrowser()`. |

- **Use your own identity.** By default every deployment presents itself as
  `AstratraWebBrowser` with the package's GitHub page: give your own page with
  `--info-url` (who you are, how to reach you), and, to sign your requests,
  your own key published on your domain (`keygen`, `--signing-key-file`,
  `--signature-agent`). A site that blocks the `AstratraWebBrowser` name in its
  `robots.txt` is refused for everyone.
- **Only Ubuntu 24.04 was tried** end to end (firewall, AppArmor, sandbox).
  Debian 12 and Ubuntu 22.04 should do; `setup` says what is missing.
- You answer for your use: terms of the sites read, `robots.txt` (the package
  respects it; do not turn that off without the right to), personal data on
  the pages.

### Isolation

Each protection holds if another one gives way:

- **User and process**: `navigateur` system user, hardened systemd unit
  (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`,
  `MemoryMax=2G`, `CPUQuota=200%`, token through `LoadCredential`, only the
  namespaces Chromium needs). The service refuses to run as root.
- **Chromium sandbox** on: a launch without it is refused (`--no-sandbox`
  forbidden). On Ubuntu 23.10 and later, the AppArmor profile from `setup` lets
  it create its namespaces.
- **Egress relay**: Chromium opens no connection itself; everything goes
  through a relay inside the service (loopback included). The relay resolves
  every name, refuses any non-public address (same ranges as
  `isPublicAddress`) and connects to the checked address: redirects,
  WebSockets, images, script `fetch` calls and DNS rebinding are covered.
  WebRTC is off.
- **System firewall, mandatory**: the nftables rules refuse the `navigateur`
  user any outgoing connection to a non-public address, except the DNS
  resolver and the relay.
- **Startup check**: the service tries to reach loopback, a private address of
  the machine and `169.254.169.254`; if one answers, it refuses to start
  (`isolation_failed`). `/health` reports the result.
- **Page**: no downloads, no `file://`, no service workers, no permissions, no
  pop-ups (closed), no dialogs (dismissed). 15 s per page, 25 s per request,
  5 redirects, 10 MB of resources (later requests are cut), 2 MB of text.

### What the model reads

**Visible** text only: hidden elements (`display`, `visibility`, `opacity`,
off-screen, one pixel, clipped, zero font size, transparent colour or the
background's colour, `aria-hidden`) are removed before reading, because hidden
text is the classic way to slip an order to an AI. Cookie banners, subscription
pop-ups and modal boxes are hidden **without clicking**. Links (https, 50 at
most, same site first) are numbered inside the frame.

These protections do for the AI what isolation does for the server: also run
pages through the guards of `@astratra/ai`, which look for prompt injection
with the guard model of `@astratra/models` and refuse any action after a
suspicion:

```js
const { createGuards } = require('@astratra/ai/guards');
const guards = createGuards({ models });          // @astratra/models client
const run = guards.newRun({ mode: 'action' });
const browse = nativeTools(ws).find((tool) => tool.name === 'browse_page');
const { data } = await browse.run({ url });
const checked = await guards.toolResult(data, run, { tool: 'browse_page', external: true });
// checked.suspected → no action without a person's approval:
await guards.beforeAction({ name: 'send_email' }, run);   // { decision: 'block', reason: 'confirmation_required' }
```

### Agent identity

- Honest `User-Agent`: `Mozilla/5.0 (compatible; AstratraWebBrowser/<version>; +<infoUrl>)`.
  `--info-url` is the page that explains the agent (by default, the package's
  GitHub page). No human imitation, no "stealth" module: a site that refuses
  agents is refused.
- `robots.txt` is respected for every page the browser opens (token
  `AstratraWebBrowser`, else `*`, one-hour cache; a failing `robots.txt` means
  no): a disallowed page gives `WEB_BROWSE_ROBOTS_DISALLOWED`. A redirect
  target is checked on arrival: the request went out, but the page is not
  returned.
- **Web Bot Auth** (optional): `astratra-web-browser keygen --out key.pem
  --directory directory.json` creates an Ed25519 key and the directory to
  publish at `/.well-known/http-message-signatures-directory` of your domain;
  with `--signing-key-file` and `--signature-agent https://your-domain`, every
  request is signed (RFC 9421: `Signature`, `Signature-Input`,
  `Signature-Agent`).

### Errors

| Code | When |
|---|---|
| `WEB_BROWSE_ROBOTS_DISALLOWED` | `robots.txt` disallows the page (or a redirect target) |
| `WEB_READ_BLOCKED_ADDRESS` | the page or a redirect points to a non-public address |
| `WEB_READ_BLOCKED_DOMAIN` | blocked site (`blockDomains`) or outside `allowDomains` |
| `WEB_BROWSE_NO_SITE_SEARCH` | neither OpenSearch nor a GET search form |
| `WEB_BROWSE_REFUSED` | a search engine's results page (use `web_search`) |
| `WEB_BROWSE_BUSY` | the service is full; try again |
| `WEB_BROWSE_TIMEOUT` | the page ran out of time |
| `WEB_BROWSER_UNAVAILABLE` | service down, circuit open, or no `browser` |
| `WEB_READ_BAD_STATUS`, `WEB_READ_UNSUPPORTED_TYPE`, `WEB_READ_TOO_MANY_REDIRECTS`, `WEB_BROWSE_FAILED` | as for `read_page` |

The client never throws: `open` and `siteSearch` return `{ ok: true, result }`
(`result.status`: `ok`, `robots_disallowed`, `blocked`…) or
`{ ok: false, code, retryable }`. 30 s timeout, a retry on network failure or
a full service, a circuit breaker (three failures in a row: 30 s of fast
refusals).

## Evaluation

`runEvaluation({ cases, search, recorder, readText })` checks, for each case:
`noMixing` (every title and snippet is exactly what the named engine gave for
that page), `noDuplicates`, `passagesVerified` (every passage is at its
position in its page), and, case by case, `expectedDomain` (the right site in
the first `within`), `recentFirst` and `forbiddenDomains`.

The test suite runs it on a fixed corpus whose simulated engines have the
defects of real ones. The tool passes the 6 cases. Raw search with a single
engine fails 4 of them (right site missing from the top 3, duplicates, old page
first, excluded site kept), and merging snippets by title fails `noMixing`. To
run it against real engines (nothing is called without a key, and keys are
never printed):

```bash
SERPER_API_KEY=… BRAVE_SEARCH_API_KEY=… npm run eval:live -w @astratra/web-search
```

## What it does not do

- It does not write an answer. It gives pages; the model answers and cites.
- Without the integrated browser, it does not run JavaScript on pages: a page
  built entirely in the browser gives little text (see
  [Integrated browser](#integrated-browser-read-only)).
- The integrated browser only reads: it does not click, fill in any form
  (except a GET search, through its address), sign in or buy. No JSON, no PDF.
- It does not read PDFs or images.
- It does not bypass paywalls, robots rules or engine terms. Check the terms of
  each engine you use, in particular about storing results.
- The date of a page is the one the engine or the page gives; it can be
  missing or wrong (`publishedAt: null` rather than a guess).
- The built-in extractor is deliberately simple; it can keep some noise or miss
  some text on complex layouts.

## Tests

```bash
npm test -w @astratra/web-search
```

The tests never call the Internet: engines are simulated, and page reads go
through a simulated network that uses the same `lookup` as the real one. The
browser tests run on a real Chromium against a small local HTTPS site of trap
pages (hidden text, redirects and WebSockets to the inside, downloads, a huge
page…); they are skipped without Playwright or Chromium.
