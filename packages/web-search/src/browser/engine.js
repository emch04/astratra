/**
 * Le moteur du navigateur intégré : un Chromium sans fenêtre (Playwright),
 * partagé, et un contexte NEUF par requête (ni cookies, ni stockage, ni cache),
 * une seule page, détruit à la fin.
 *
 * Chaque requête de la page passe par `guard` (https, ports, adresses
 * publiques), chaque page ouverte par `robots.txt` et par la politique de
 * sites de la demande ; les WebSocket aussi sont contrôlées. Ni
 * téléchargement, ni service worker, ni permission, ni fenêtre surgissante,
 * ni boîte de dialogue. Le cloisonnement de Chromium reste actif : un
 * lancement sans lui est refusé.
 *
 * Statuts rendus (jamais d'exception pour une page) :
 *   ok, blocked, robots_disallowed, domain_refused, bad_status, timeout,
 *   too_many_redirects, unsupported_type, no_site_search, search_engine_refused,
 *   failed ; et busy quand la file est pleine.
 */

const { createRequestGuard } = require('./guard');
const { startEgressProxy } = require('./egressProxy');
const { createRobotsCache, ROBOTS_AGENT_TOKEN } = require('./robots');
const { readRenderedPage } = require('./pageScript');
const { openSearchUrl, formSearchUrl, isSearchEngine, cleanSiteQuery } = require('./siteSearch');
const { extractPage } = require('../extract');
const { safeFetch } = require('../safeFetch');
const { domainOf, sameSite, normalizeSite, inSite, parseHttps } = require('../url');
const { isBlockedHostname } = require('../address');
const { WebSearchError, CODES } = require('../errors');

const VERSION = require('../../package.json').version;
const DEFAULT_INFO_URL = 'https://github.com/emch04/astratra/tree/main/packages/web-search';

const DEFAULTS = Object.freeze({
  maxContexts: 2,
  queueMs: 10_000,
  maxQueue: 32,
  pageTimeoutMs: 15_000,
  requestTimeoutMs: 25_000,
  settleMs: 4_000,
  maxRedirects: 5,
  maxResourceBytes: 10_000_000,
  maxTextChars: 2_000_000,
  maxLinks: 50,
  viewport: { width: 1280, height: 800 }
});

const HTML_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

/* Des drapeaux qui coupent ce que Chromium ferait de lui-même sur le réseau, et WebRTC. */
const CHROMIUM_ARGS = [
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-sync',
  '--disable-client-side-phishing-detection',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-pings',
  '--disable-features=MediaRouter,OptimizationHints,Translate,AutofillServerCommunication,InterestFeedContentSuggestions,PrivacySandboxSettings4,DialMediaRouteProvider'
];

/** Le module playwright de l'application (dépendance d'appairage facultative). */
function loadPlaywright() {
  const attempts = [() => require('playwright'), () => require(require.resolve('playwright', { paths: [process.cwd()] }))];
  for (const attempt of attempts) {
    try {
      const module = attempt();
      if (module?.chromium) return module;
    } catch (_error) {
      /* essai suivant */
    }
  }
  throw new WebSearchError(CODES.BROWSER_UNAVAILABLE, 'the integrated browser needs playwright: npm install playwright && npx playwright install chromium-headless-shell');
}

/** Le User-Agent honnête de l'agent. */
function browserUserAgent({ version = VERSION, infoUrl = DEFAULT_INFO_URL } = {}) {
  const info = String(infoUrl).replace(/[^\x21-\x7e]/g, '');
  return `Mozilla/5.0 (compatible; AstratraWebBrowser/${version}; +${info})`;
}

/** Une file bornée : `max` en parallèle, attente au plus `waitMs`, `maxQueue` en attente. */
function createSlots({ max, waitMs, maxQueue }) {
  let active = 0;
  const waiting = [];
  function release() {
    active -= 1;
    while (waiting.length) {
      const next = waiting.shift();
      if (next.done) continue;
      next.done = true;
      clearTimeout(next.timer);
      active += 1;
      next.resolve(release);
      return;
    }
  }
  function acquire(signal) {
    if (active < max) {
      active += 1;
      return Promise.resolve(release);
    }
    if (waiting.length >= maxQueue) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry = { done: false, resolve };
      entry.timer = setTimeout(() => {
        if (entry.done) return;
        entry.done = true;
        resolve(null);
      }, waitMs);
      signal?.addEventListener?.('abort', () => {
        if (entry.done) return;
        entry.done = true;
        clearTimeout(entry.timer);
        resolve(null);
      }, { once: true });
      waiting.push(entry);
    });
  }
  return { acquire, stats: () => ({ active, queued: waiting.filter((entry) => !entry.done).length, max }) };
}

const sites = (list) => (Array.isArray(list) ? list.map(normalizeSite).filter(Boolean) : []);

/** La politique de sites d'une demande : null si permis, sinon la raison. */
function domainRefusal(url, { allowDomains, blockDomains }) {
  const domain = domainOf(url);
  if (!domain) return 'domain';
  if (blockDomains.some((site) => inSite(domain, site))) return 'blocked_domain';
  if (allowDomains.length && !allowDomains.some((site) => inSite(domain, site))) return 'not_allowed_domain';
  return null;
}

/** Le résultat d'un échec, sous la même forme qu'une page. */
const failure = (status, url, extra = {}) => ({ status, url, ...extra });

/** Robots.txt lu par la lecture sûre du paquet (https, adresses publiques). */
function defaultFetchRobots({ userAgent, resolve }) {
  return async (url, { signal } = {}) => {
    try {
      const page = await safeFetch(url, { timeoutMs: 5_000, maxBytes: 500 * 1024, userAgent, signal, resolve });
      return { status: page.status, body: page.body };
    } catch (error) {
      if (error?.code === CODES.BAD_STATUS) return { status: error.status, body: '' };
      /* Un robots.txt servi sous un type inattendu ne se lit pas : comme s'il était vide. */
      if (error?.code === CODES.UNSUPPORTED_TYPE) return { status: 200, body: '' };
      throw error;
    }
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.playwright]        le module playwright (sinon chargé depuis l'application).
 * @param {string} [options.executablePath]    un autre binaire Chromium.
 * @param {string} [options.infoUrl]           la page qui explique l'agent (User-Agent).
 * @param {object} [options.signer]            createRequestSigner(…) : Web Bot Auth.
 * @param {boolean} [options.robots]           respecter robots.txt. Défaut true.
 * @param {Function} [options.fetchRobots]     (url, { signal }) => { status, body }.
 * @param {number[]} [options.ports]           Défaut [443].
 * @param {boolean} [options.allowHttp]        sous-ressources en http. Défaut false.
 * @param {Function} [options.resolve]         dns.lookup (tests).
 * @param {number} [options.maxContexts]       pages en parallèle. Défaut 2.
 * @param {number} [options.queueMs]           attente au plus. Défaut 10 s.
 * @param {number} [options.pageTimeoutMs]     Défaut 15 s.
 * @param {number} [options.requestTimeoutMs]  Défaut 25 s.
 * @param {number} [options.maxRedirects]      Défaut 5.
 * @param {number} [options.maxResourceBytes]  Défaut 10 Mo.
 * @param {number} [options.maxTextChars]      Défaut 2 000 000.
 * @param {number} [options.proxyPort]         le port du relais de sortie (fixe en production, pour le pare-feu). Défaut 0 (libre).
 * @param {Function} [options.connect]         tests seulement : ({ hostname, address, port }) => net.Socket.
 * @param {boolean} [options.insecureTls]      tests seulement : certificats non vérifiés.
 */
function createBrowserEngine(options = {}) {
  const settings = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
  const userAgent = options.userAgent || browserUserAgent({ infoUrl: options.infoUrl || DEFAULT_INFO_URL });
  const guard = createRequestGuard({ resolve: options.resolve, ports: options.ports, allowHttp: options.allowHttp });
  const robots = options.robots === false ? null : (options.robotsCache || createRobotsCache({
    token: ROBOTS_AGENT_TOKEN,
    fetchRobots: options.fetchRobots || defaultFetchRobots({ userAgent, resolve: options.resolve })
  }));
  const slots = createSlots({ max: settings.maxContexts, waitMs: settings.queueMs, maxQueue: settings.maxQueue });
  const signer = options.signer || null;
  let browser = null;
  let proxy = null;
  let launching = null;
  let chromiumVersion = null;
  let closed = false;

  function args() {
    const list = [...CHROMIUM_ARGS];
    if (list.some((arg) => /^--no-sandbox|^--disable-setuid-sandbox|^--no-zygote-sandbox/.test(arg))) {
      throw new WebSearchError(CODES.BROWSER_UNAVAILABLE, 'the Chromium sandbox cannot be turned off');
    }
    return list;
  }

  async function launch() {
    if (closed) throw new WebSearchError(CODES.BROWSER_UNAVAILABLE, 'the browser engine is closed');
    if (browser?.isConnected()) return browser;
    if (launching) return launching;
    launching = (async () => {
      const playwright = options.playwright || loadPlaywright();
      if (!proxy) {
        proxy = await startEgressProxy({
          resolve: options.resolve,
          connect: options.connect,
          ports: options.ports,
          allowHttp: options.allowHttp,
          port: options.proxyPort ?? 0
        });
      }
      const launched = await playwright.chromium.launch({
        headless: true,
        chromiumSandbox: true,
        args: args(),
        /* Tout le trafic de Chromium, boucle locale comprise, passe par le relais. */
        proxy: { server: proxy.server, bypass: '<-loopback>', username: proxy.username, password: proxy.password },
        timeout: 30_000,
        ...(options.executablePath ? { executablePath: options.executablePath } : {})
      });
      const spawnargs = launched.process?.()?.spawnargs || [];
      if (spawnargs.some((arg) => arg === '--no-sandbox')) {
        await launched.close().catch(() => {});
        throw new WebSearchError(CODES.BROWSER_UNAVAILABLE, 'Chromium was started without its sandbox');
      }
      chromiumVersion = launched.version();
      launched.on('disconnected', () => {
        if (browser === launched) browser = null;
      });
      browser = launched;
      return launched;
    })();
    try {
      return await launching;
    } finally {
      launching = null;
    }
  }

  /**
   * Une session : un contexte neuf, une page, et l'état des contrôles.
   */
  async function newSession(policy, deadline) {
    const instance = await launch();
    const context = await instance.newContext({
      viewport: settings.viewport,
      screen: settings.viewport,
      userAgent,
      acceptDownloads: false,
      serviceWorkers: 'block',
      permissions: [],
      javaScriptEnabled: true,
      bypassCSP: false,
      locale: policy.lang || 'en-US',
      extraHTTPHeaders: { 'accept-language': `${policy.lang || 'en'},*;q=0.5` },
      ...(options.insecureTls ? { ignoreHTTPSErrors: true } : {})
    });
    const state = {
      bytes: 0,
      announced: 0,
      overBudget: false,
      navigations: 0,
      blockedRequests: 0,
      mainRefusal: null,
      robots: null
    };
    let page = null;
    const isMainDocument = (request) => {
      try {
        return request.isNavigationRequest() && Boolean(page) && request.frame() === page.mainFrame();
      } catch (_error) {
        return false;
      }
    };
    await context.route('**/*', async (route, request) => {
      const url = request.url();
      const main = isMainDocument(request);
      const refuse = async (reason) => {
        state.blockedRequests += 1;
        if (main && !state.mainRefusal) state.mainRefusal = reason;
        await route.abort('blockedbyclient').catch(() => {});
      };
      try {
        if (main) {
          state.navigations += 1;
          if (state.navigations > 1 + settings.maxRedirects) return await refuse('too_many_redirects');
        } else if (state.overBudget) {
          return await refuse('resource_limit');
        }
        const checked = await guard.check(url, { document: main });
        if (!checked.ok) return await refuse(checked.reason);
        if (main) {
          const refusal = domainRefusal(url, policy);
          if (refusal) return await refuse(refusal);
          if (robots && !policy.skipRobots) {
            const verdict = await robots.check(url, { signal: globalThis.AbortSignal.timeout(Math.max(1, Math.min(6_000, deadline - Date.now()))) });
            if (!verdict.allowed) {
              state.robots = { url, ...(verdict.unavailable ? { unavailable: true } : {}) };
              return await refuse('robots');
            }
          }
        }
        if (signer) {
          await route.continue({ headers: { ...request.headers(), ...signer.sign(url) } });
        } else {
          await route.continue();
        }
      } catch (_error) {
        await refuse('check_failed');
      }
    });
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket(/.*/, async (socket) => {
        const checked = state.overBudget ? { ok: false } : await guard.check(socket.url()).catch(() => ({ ok: false }));
        if (!checked.ok) {
          state.blockedRequests += 1;
          await Promise.resolve(socket.close({ code: 1008, reason: 'blocked' })).catch(() => {});
          return;
        }
        socket.connectToServer();
      });
    }
    context.on('page', (other) => {
      if (page && other !== page) other.close().catch(() => {});
    });
    page = await context.newPage();
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    page.on('download', (download) => download.cancel().catch(() => {}));
    page.on('requestfinished', async (request) => {
      try {
        const sizes = await request.sizes();
        state.bytes += (sizes.responseBodySize || 0) + (sizes.responseHeadersSize || 0);
        if (state.bytes > settings.maxResourceBytes) state.overBudget = true;
      } catch (_error) {
        /* page fermée */
      }
    });
    page.on('response', (response) => {
      /* Les tailles annoncées comptent dès la réponse : plusieurs ressources lourdes en parallèle ne passent pas toutes. */
      const declared = Number(response.headers()['content-length']);
      if (Number.isFinite(declared) && declared > 0) state.announced += declared;
      if (state.announced > settings.maxResourceBytes) state.overBudget = true;
    });

    /**
     * Les redirections suivies par Chromium (l'interception ne les voit pas ; le
     * relais de sortie a déjà refusé toute adresse interne) : chaque étape est
     * revérifiée, puis passée à la politique de sites et à robots.txt. Une
     * étape refusée : la page n'est pas rendue.
     */
    async function checkRedirects(response) {
      const chain = [];
      for (let request = response.request(); request; request = request.redirectedFrom()) chain.unshift(request.url());
      if (chain.length - 1 > settings.maxRedirects) return failure('too_many_redirects');
      for (const hop of chain.slice(1)) {
        const checked = await guard.check(hop, { document: true });
        if (!checked.ok) return failure('blocked', undefined, { reason: checked.reason, blockedUrl: hop });
        const refusal = domainRefusal(hop, policy);
        if (refusal) return failure('domain_refused', undefined, { reason: refusal, blockedUrl: hop });
        if (robots && !policy.skipRobots) {
          const verdict = await robots.check(hop, { signal: globalThis.AbortSignal.timeout(Math.max(1, Math.min(6_000, deadline - Date.now()))) });
          if (!verdict.allowed) return failure('robots_disallowed', undefined, { blockedUrl: hop, ...(verdict.unavailable ? { robotsUnavailable: true } : {}) });
        }
      }
      return null;
    }

    /** Ouvre une adresse ; rend la réponse, ou le statut d'échec. */
    async function navigate(url, { document = true } = {}) {
      state.navigations = 0;
      state.mainRefusal = null;
      state.robots = null;
      const remaining = deadline - Date.now();
      if (remaining <= 500) return { failure: failure('timeout', url) };
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(settings.pageTimeoutMs, remaining) });
        if (!response) return { failure: failure('failed', url, { reason: 'no_response' }) };
        const refused = await checkRedirects(response);
        if (refused) return { failure: { ...refused, url } };
        if (document) {
          const status = response.status();
          if (status >= 400) return { failure: failure('bad_status', url, { httpStatus: status, finalUrl: page.url() }) };
          const type = String(response.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (type && !HTML_TYPES.includes(type)) return { failure: failure('unsupported_type', url, { contentType: type.slice(0, 80) }) };
        }
        return { response };
      } catch (error) {
        const message = String(error?.message || '');
        if (state.robots) return { failure: failure('robots_disallowed', url, { blockedUrl: state.robots.url, ...(state.robots.unavailable ? { robotsUnavailable: true } : {}) }) };
        if (state.mainRefusal === 'too_many_redirects') return { failure: failure('too_many_redirects', url) };
        if (state.mainRefusal === 'blocked_domain' || state.mainRefusal === 'not_allowed_domain') return { failure: failure('domain_refused', url, { reason: state.mainRefusal }) };
        if (state.mainRefusal) return { failure: failure('blocked', url, { reason: state.mainRefusal }) };
        if (/Download is starting/.test(message)) return { failure: failure('unsupported_type', url, { reason: 'download' }) };
        if (/ERR_TOO_MANY_REDIRECTS/.test(message)) return { failure: failure('too_many_redirects', url) };
        if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) return { failure: failure('blocked', url, { reason: 'egress_refused' }) };
        if (/Timeout|timed out/i.test(message)) return { failure: failure('timeout', url) };
        return { failure: failure('failed', url, { reason: (/net::[A-Z_]+/.exec(message) || ['navigation_failed'])[0].slice(0, 60) }) };
      }
    }

    /** Attend que la page se pose, puis la lit. */
    async function extract(url, response, { screenshot, waitFor, pageStarted }) {
      const settle = Math.min(settings.settleMs, deadline - Date.now() - 2_000, settings.pageTimeoutMs - (Date.now() - pageStarted));
      if (settle > 0) await page.waitForLoadState('networkidle', { timeout: settle }).catch(() => {});
      if (waitFor) {
        const wait = Math.min(settings.pageTimeoutMs - (Date.now() - pageStarted), deadline - Date.now() - 2_000);
        if (wait > 0) await page.waitForSelector(waitFor, { state: 'visible', timeout: wait }).catch(() => {});
      }
      if (page.url().startsWith('chrome-error:')) {
        /* Une navigation de la page (script, balise meta) a été refusée : l'onglet montre une page d'erreur. */
        return { refusal: failure(state.robots ? 'robots_disallowed' : 'blocked', url, { reason: state.robots ? 'robots' : state.mainRefusal || 'navigation_refused' }) };
      }
      const data = await page.evaluate(readRenderedPage, { maxElements: 10_000, maxTextChars: settings.maxTextChars, maxLinksScanned: 400 });
      const finalUrl = page.url();
      let meta;
      try {
        const html = (await page.content()).slice(0, 2_000_000);
        meta = extractPage(html, { url: finalUrl, now: Date.now() }) || {};
      } catch (_error) {
        meta = {};
      }
      const links = orderLinks(data.links, finalUrl, settings.maxLinks);
      const result = {
        status: 'ok',
        url,
        finalUrl,
        httpStatus: response.status(),
        title: data.title || String(meta.title || ''),
        lang: data.lang || meta.lang || null,
        text: data.text,
        links,
        canonical: meta.canonical && parseHttps(meta.canonical) && sameSite(meta.canonical, finalUrl) ? meta.canonical : null,
        publishedAt: meta.publishedAt || null,
        modifiedAt: meta.modifiedAt || null,
        truncated: Boolean(data.textTruncated || state.overBudget),
        resourceLimitReached: state.overBudget,
        blockedRequests: state.blockedRequests,
        removed: data.removed
      };
      if (screenshot) {
        const image = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: Math.max(1_000, Math.min(5_000, deadline - Date.now())) });
        result.screenshot = { mediaType: 'image/png', data: image.toString('base64'), width: settings.viewport.width, height: settings.viewport.height };
      }
      return { result, data };
    }

    /**
     * Le corps d'une ressource lue par la page elle-même (description OpenSearch) :
     * un `fetch` de la page, qui passe par les mêmes contrôles que ses autres
     * requêtes. Ouverte comme une page, une description XML serait un téléchargement.
     */
    async function rawText(url, maxChars) {
      try {
        const answer = await page.evaluate(async ({ href, max }) => {
          const response = await globalThis.fetch(href, { credentials: 'omit', redirect: 'follow' });
          if (!response.ok) return null;
          return (await response.text()).slice(0, max);
        }, { href: url, max: maxChars });
        return typeof answer === 'string' ? answer : null;
      } catch (_error) {
        return null;
      }
    }

    return {
      navigate,
      extract,
      rawText,
      close: () => Promise.race([context.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())])
    };
  }

  /** Une demande : file, délai total, session fermée quoi qu'il arrive. */
  async function run(request, callOptions, work) {
    const started = Date.now();
    const release = await slots.acquire(callOptions.signal);
    if (!release) return failure('busy', request.url);
    const deadline = started + settings.requestTimeoutMs;
    let session = null;
    let timer = null;
    try {
      const policy = {
        allowDomains: sites(request.allowDomains),
        blockDomains: sites(request.blockDomains),
        lang: typeof request.lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(request.lang) ? request.lang : null
      };
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(failure('timeout', request.url)), Math.max(0, deadline - Date.now()));
      });
      const aborted = new Promise((resolve) => {
        callOptions.signal?.addEventListener?.('abort', () => resolve(failure('timeout', request.url, { reason: 'aborted' })), { once: true });
      });
      const job = (async () => {
        session = await newSession(policy, deadline);
        return work(session, deadline);
      })().catch((error) => {
        if (error instanceof WebSearchError && error.code === CODES.BROWSER_UNAVAILABLE) return failure('browser_unavailable', request.url, { reason: error.message });
        return failure('failed', request.url, { reason: 'browser_error' });
      });
      const result = await Promise.race([job, timeout, aborted]);
      return { ...result, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
      /* La session peut naître après le délai : on la ferme dès qu'elle existe. */
      const closeLater = async () => {
        for (let i = 0; i < 300 && !session; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        if (session) await session.close();
      };
      if (session) await session.close();
      else closeLater().catch(() => {});
      release();
    }
  }

  function badRequest(url, reason) {
    return failure('invalid_input', url, { reason });
  }

  /**
   * Ouvre une page.
   * @param {{ url: string, screenshot?: boolean, waitFor?: string, allowDomains?: string[], blockDomains?: string[], lang?: string }} request
   */
  async function open(request = {}, callOptions = {}) {
    if (typeof request.url !== 'string' || !parseHttps(request.url)) return badRequest(request.url, 'url');
    if (request.waitFor !== undefined && (typeof request.waitFor !== 'string' || request.waitFor.length > 200)) return badRequest(request.url, 'waitFor');
    return run(request, callOptions, async (session) => {
      const pageStarted = Date.now();
      const opened = await session.navigate(request.url);
      if (opened.failure) return opened.failure;
      const { result, refusal } = await session.extract(request.url, opened.response, { screenshot: request.screenshot === true, waitFor: request.waitFor, pageStarted });
      return refusal || result;
    });
  }

  /**
   * La recherche interne d'un site.
   * @param {{ url: string, query: string, screenshot?: boolean, allowDomains?: string[], blockDomains?: string[], lang?: string }} request
   */
  async function siteSearch(request = {}, callOptions = {}) {
    if (typeof request.url !== 'string' || !parseHttps(request.url)) return badRequest(request.url, 'url');
    const query = cleanSiteQuery(request.query);
    if (!query) return badRequest(request.url, 'query');
    if (isSearchEngine(request.url)) return failure('search_engine_refused', request.url);
    return run(request, callOptions, async (session) => {
      let pageStarted = Date.now();
      const opened = await session.navigate(request.url);
      if (opened.failure) return opened.failure;
      const { data, result: first, refusal: firstRefusal } = await session.extract(request.url, opened.response, { screenshot: false, pageStarted });
      if (firstRefusal) return firstRefusal;
      const pageUrl = first.finalUrl;
      let searchUrl = null;
      let via = null;
      for (const href of data.openSearch || []) {
        if (!parseHttps(href) || !sameSite(href, pageUrl)) continue;
        const xml = await session.rawText(href, 100_000);
        searchUrl = xml ? openSearchUrl(xml, { query, pageUrl }) : null;
        if (searchUrl) {
          via = 'opensearch';
          break;
        }
      }
      if (!searchUrl) {
        for (const form of data.forms || []) {
          searchUrl = formSearchUrl(form, { query, pageUrl });
          if (searchUrl) {
            via = 'form';
            break;
          }
        }
      }
      if (!searchUrl) return failure('no_site_search', request.url);
      pageStarted = Date.now();
      const results = await session.navigate(searchUrl);
      if (results.failure) return { ...results.failure, searchUrl, via };
      const { result, refusal } = await session.extract(searchUrl, results.response, { screenshot: request.screenshot === true, pageStarted });
      if (refusal) return { ...refusal, searchUrl, via };
      return { ...result, url: request.url, searchUrl, via, query };
    });
  }

  async function health() {
    let ok = true;
    let error = null;
    try {
      await launch();
    } catch (failed) {
      ok = false;
      error = failed instanceof WebSearchError ? failed.message : 'launch failed';
    }
    return {
      ok,
      version: VERSION,
      chromium: chromiumVersion,
      sandbox: ok,
      userAgent,
      robots: Boolean(robots),
      signing: signer ? { keyid: signer.keyid } : null,
      ...slots.stats(),
      ...(error ? { error } : {})
    };
  }

  async function close() {
    closed = true;
    const current = browser;
    browser = null;
    if (current) await current.close().catch(() => {});
    if (proxy) await proxy.close();
    proxy = null;
  }

  return { open, siteSearch, health, start: launch, close, userAgent };
}

/** Les liens https publics, ceux du même site d'abord, numérotés. */
function orderLinks(links, pageUrl, max) {
  const usable = (Array.isArray(links) ? links : []).filter((link) => {
    const url = parseHttps(link.url);
    return url && !isBlockedHostname(url.hostname);
  });
  const same = usable.filter((link) => sameSite(link.url, pageUrl));
  const other = usable.filter((link) => !sameSite(link.url, pageUrl));
  return [...same, ...other].slice(0, max).map((link, index) => ({ n: index + 1, url: link.url, text: link.text, sameSite: sameSite(link.url, pageUrl) }));
}

module.exports = { createBrowserEngine, browserUserAgent, orderLinks, loadPlaywright, BROWSER_DEFAULTS: DEFAULTS, DEFAULT_INFO_URL };
