# @astratra/web-search

Web search for AI agents, where every fact stays attached to its page.

Several engines (Serper for Google results, Brave Search, Tavily, Exa, or a
search gateway of your own) with automatic fallback; their **rankings** are fused, their
**contents never are**. Each result is one page of one site, with its exact
address, its domain, its date when known, the excerpt of **one** engine for
**that** page, and, when the page is read, passages quoted word for word with
their position. Pages are read without opening a door to your internal network
(SSRF), and everything a model reads from the web is framed as data, not
instructions.

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
const { createWebSearch, gatewayProvider, braveProvider, formatForModel } = require('@astratra/web-search');

const ws = createWebSearch({
  providers: [
    gatewayProvider({ search: (demande, { signal }) => maPasserelle.rechercher(demande, { signal }) }),
    braveProvider({ key: () => process.env.BRAVE_SEARCH_API_KEY })
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
| `gatewayProvider({ search })` | a search gateway of your own | The engine keys stay with your gateway, which counts the cost (`costPerCallUsd: null`). Sites are sent as `site:` operators. |
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
- **MCP**: `createMcpServer(ws)` from `@astratra/web-search/mcp` (needs
  `@modelcontextprotocol/sdk`) serves the same two tools, marked read-only. A
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
- It does not run JavaScript on pages: a page built entirely in the browser
  gives little text. Plug in your own `extract`, or read such pages another way.
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
through a simulated network that uses the same `lookup` as the real one.
