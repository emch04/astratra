/**
 * La recherche web d'un agent : plusieurs moteurs, un classement fusionné, et
 * chaque fait attaché à SA page.
 *
 *   const ws = createWebSearch({ providers: [gatewayProvider(…), braveProvider({ key })] });
 *   const found = await ws.search({ query, freshness: 'auto', sites: [], read: 2 });
 *   const page = await ws.read(url, { quotes: ['une phrase à vérifier'] });
 *
 * Deux modes :
 * - 'fuse' (défaut) : les `fuseCount` premiers moteurs disponibles répondent
 *   ensemble, leurs classements sont fusionnés (RRF) ; un moteur en panne est
 *   remplacé par le suivant de la liste ;
 * - 'fallback' : un moteur à la fois, le suivant seulement si le précédent
 *   échoue ou ne trouve rien.
 *
 * Robustesse et coût : cache par moteur et par page, quotas par moteur
 * (minute, jour, 30 jours), nouvel essai seulement quand il a une chance
 * (réseau, 5xx), repos d'un moteur qui annonce un quota épuisé (402, 429),
 * budget de temps total. Chaque réponse porte un compte rendu : moteurs
 * essayés et utilisés, échecs (code et statut, jamais une clé), coût estimé,
 * temps, ce qui vient du cache.
 */

const crypto = require('crypto');
const { WebSearchError, CODES } = require('./errors');
const { normalizeRequest } = require('./query');
const { fuseRankings, rankEntries } = require('./fusion');
const { canonicalUrl, domainOf, sameSite, normalizeSite, inSite } = require('./url');
const { safeFetch, checkUrl, SAFE_FETCH_DEFAULTS } = require('./safeFetch');
const { extractPage } = require('./extract');
const { findQuote, bestPassages } = require('./passages');
const { createMemoryCache, createMemoryCounters } = require('./stores');
const { clip } = require('./text');

const WINDOWS = { perMinute: 60_000, perDay: 86_400_000, perMonth: 30 * 86_400_000 };
const MAX_READ = 5;
const MAX_QUOTES = 10;

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

/* Les mots d'un texte : ce qui porte une lettre ou un chiffre. */
const wordCount = (text) => String(text || '').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

/** L'adresse https donnée, sinon celle de repli. */
function parseHttpsOr(value, fallback) {
  return typeof value === 'string' && canonicalUrl(value) ? value : fallback;
}

function validateProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new WebSearchError(CODES.NO_PROVIDER, 'createWebSearch needs at least one provider');
  }
  const ids = new Set();
  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(provider.id)) throw new Error('A provider needs an id in lower case.');
    if (typeof provider.search !== 'function') throw new Error(`The provider ${provider.id} has no search().`);
    if (ids.has(provider.id)) throw new Error(`The provider ${provider.id} is declared twice.`);
    ids.add(provider.id);
  }
  return providers;
}

/**
 * @param {object} options
 * @param {object[]} options.providers           dans l'ordre de préférence.
 * @param {'fuse'|'fallback'} [options.mode]     Défaut 'fuse'.
 * @param {number} [options.fuseCount]           moteurs fusionnés en mode 'fuse'. Défaut 2.
 * @param {boolean} [options.fallbackOnEmpty]    un moteur qui ne trouve rien laisse sa place. Défaut true.
 * @param {object|false} [options.cache]         { get, set } ; false pour aucun cache. Défaut : en mémoire.
 * @param {number} [options.cacheTtlMs]          Défaut 10 min (un moteur peut le réduire : Brave, 1 min).
 * @param {number} [options.readCacheTtlMs]      Défaut 5 min.
 * @param {Record<string, { perMinute?: number, perDay?: number, perMonth?: number }>} [options.quotas]
 * @param {object} [options.quotaStore]          { get, incr }. Défaut : en mémoire.
 * @param {{ retries?: number, baseDelayMs?: number, maxDelayMs?: number }} [options.retry] Défaut 1 nouvel essai, 300 ms.
 * @param {number} [options.cooldownMs]          repos d'un moteur à court de quota. Défaut 60 s.
 * @param {number} [options.budgetMs]            temps total d'une recherche, lectures comprises. Défaut 25 s.
 * @param {object} [options.ranking]             { blockDomains, preferDomains, demoteDomains, domainScore, maxPerDomain }.
 * @param {object} [options.reading]             { timeoutMs, maxBytes, maxChars, passages, passageSize, ports, userAgent,
 *                                                browser: 'fallback'|'always'|'never', minWords }.
 * @param {object} [options.browser]             le navigateur intégré : createBrowserClient(…) ou createLocalBrowser(…).
 * @param {string[]} [options.allowDomains]      si donné, seules ces pages (et leurs sous-domaines) sont lues ou ouvertes.
 * @param {Function} [options.rewrite]           async (request) => string | { query } : réécrire la requête.
 * @param {Function} [options.extract]           (html, { url }) => { text, title?, … } : un autre extracteur.
 * @param {Function} [options.onReport]          (report) => void, après chaque recherche.
 * @param {string} [options.lang]                langue par défaut.
 * @param {string} [options.country]             pays par défaut.
 * @param {number} [options.limit]               nombre de résultats par défaut (8).
 * @param {Function} [options.now]               l'horloge.
 * @param {Function} [options.sleep]             (ms, signal) => Promise.
 * @param {Function} [options.random]            pour l'aléa des attentes.
 * @param {Function} [options.request]           https.request des lectures (tests).
 * @param {Function} [options.resolve]           dns.lookup des lectures (tests).
 */
function createWebSearch(options = {}) {
  const providers = validateProviders(options.providers);
  const mode = options.mode || 'fuse';
  if (!['fuse', 'fallback'].includes(mode)) throw new Error("mode must be 'fuse' or 'fallback'.");
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const random = options.random || Math.random;
  const fuseCount = Math.max(1, Math.min(providers.length, options.fuseCount ?? 2));
  const fallbackOnEmpty = options.fallbackOnEmpty !== false;
  const cache = options.cache === false ? null : (options.cache || createMemoryCache({ now }));
  const cacheTtlMs = options.cacheTtlMs ?? 600_000;
  const readCacheTtlMs = options.readCacheTtlMs ?? 300_000;
  const quotas = options.quotas || {};
  const quotaStore = options.quotaStore || createMemoryCounters({ now });
  const retry = { retries: 1, baseDelayMs: 300, maxDelayMs: 2_000, ...(options.retry || {}) };
  const cooldownMs = options.cooldownMs ?? 60_000;
  const budgetMs = options.budgetMs ?? 25_000;
  const ranking = {
    ...(options.ranking || {}),
    blockDomains: (options.ranking?.blockDomains || []).map(normalizeSite).filter(Boolean),
    preferDomains: (options.ranking?.preferDomains || []).map(normalizeSite).filter(Boolean),
    demoteDomains: (options.ranking?.demoteDomains || []).map(normalizeSite).filter(Boolean)
  };
  const reading = { maxChars: 60_000, passages: 3, passageSize: 500, minWords: 200, ...(options.reading || {}) };
  const browser = options.browser || null;
  if (browser && (typeof browser.open !== 'function' || typeof browser.siteSearch !== 'function')) {
    throw new Error('browser must come from createBrowserClient() or createLocalBrowser().');
  }
  const browserMode = browser ? (reading.browser || 'fallback') : 'never';
  if (!['fallback', 'always', 'never'].includes(browserMode)) throw new Error("reading.browser must be 'fallback', 'always' or 'never'.");
  const allowDomains = (options.allowDomains || []).map(normalizeSite).filter(Boolean);
  const extract = options.extract || extractPage;
  const resting = new Map();

  async function cacheGet(key) {
    if (!cache) return undefined;
    try {
      return await cache.get(key);
    } catch (_error) {
      return undefined;
    }
  }
  async function cacheSet(key, value, ttl) {
    if (!cache || !(ttl > 0)) return;
    try {
      await cache.set(key, value, ttl);
    } catch (_error) {
      /* un cache en panne ne casse pas la recherche */
    }
  }

  /**
   * null si le moteur peut être appelé, sinon la raison. Un magasin de quotas en
   * panne ferme le moteur qui a des quotas (un quota payant ne se dépasse pas à
   * l'aveugle) ; les autres moteurs n'en dépendent pas.
   */
  async function unavailable(provider) {
    const until = resting.get(provider.id);
    if (until && until > now()) return 'resting';
    const limits = quotas[provider.id] || {};
    try {
      for (const [window, ms] of Object.entries(WINDOWS)) {
        const limit = limits[window];
        if (!Number.isFinite(limit)) continue;
        const key = `ws:quota:${provider.id}:${window}:${Math.floor(now() / ms)}`;
        if ((await quotaStore.get(key)) >= limit) return 'quota';
      }
    } catch (_error) {
      return 'quota_store_failed';
    }
    return null;
  }

  /**
   * Réserve un appel : le compteur est incrémenté PUIS comparé, si bien que deux
   * recherches simultanées à la limite ne passent pas toutes les deux.
   * @returns {Promise<null|string>} null si l'appel est réservé, sinon la raison.
   */
  async function reserve(provider) {
    const limits = quotas[provider.id] || {};
    try {
      for (const [window, ms] of Object.entries(WINDOWS)) {
        const limit = limits[window];
        if (!Number.isFinite(limit)) continue;
        const count = await quotaStore.incr(`ws:quota:${provider.id}:${window}:${Math.floor(now() / ms)}`, ms);
        if (count > limit) return 'quota';
      }
    } catch (_error) {
      return 'quota_store_failed';
    }
    return null;
  }

  /** Un moteur, avec cache, quota et nouvel essai raisonné. */
  async function callProvider(provider, request, signal) {
    const started = now();
    const trace = { provider: provider.id, ok: false, cached: false, attempts: 0, ms: 0, hits: 0, costUsd: null };
    const key = `ws:search:${provider.id}:${hash([request.query, request.lang, request.country, request.freshness, request.sites, request.excludeSites, request.limit])}`;
    const cached = await cacheGet(key);
    if (cached && Array.isArray(cached.hits)) {
      Object.assign(trace, { ok: true, cached: true, hits: cached.hits.length, costUsd: 0, ms: now() - started });
      return { trace, hits: cached.hits };
    }
    const reason = await unavailable(provider);
    if (reason) {
      Object.assign(trace, { skipped: reason, ms: now() - started });
      return { trace, hits: null };
    }
    let lastError = null;
    for (let attempt = 0; attempt <= retry.retries; attempt += 1) {
      if (signal.aborted) break;
      const refused = await reserve(provider);
      if (refused) {
        trace.skipped = refused;
        break;
      }
      trace.attempts += 1;
      try {
        const answer = await provider.search(request, { signal, now: now() });
        const hits = (Array.isArray(answer?.hits) ? answer.hits : [])
          .filter((hit) => hit && typeof hit.url === 'string' && typeof hit.title === 'string' && hit.title.trim() && canonicalUrl(hit.url));
        const cost = Number.isFinite(answer?.costUsd) ? answer.costUsd : provider.costPerCallUsd ?? null;
        Object.assign(trace, { ok: true, hits: hits.length, costUsd: cost, ms: now() - started, ...(answer?.engine ? { engine: answer.engine } : {}) });
        await cacheSet(key, { hits }, provider.cacheTtlMs ?? cacheTtlMs);
        return { trace, hits };
      } catch (error) {
        if (signal.aborted) break;
        lastError = error instanceof WebSearchError ? error : new WebSearchError(CODES.PROVIDER_FAILED, `${provider.id} failed`, { provider: provider.id });
        if (lastError.quota) {
          resting.set(provider.id, now() + cooldownMs);
          break;
        }
        if (!lastError.retryable || attempt === retry.retries) break;
        const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt) * (0.5 + random() / 2);
        try {
          await sleep(delay, signal);
        } catch (_error) {
          break;
        }
      }
    }
    Object.assign(trace, {
      ms: now() - started,
      ...(lastError
        ? { error: { code: lastError.code, message: lastError.message, ...(lastError.status !== undefined ? { status: lastError.status } : {}) } }
        : trace.skipped ? {} : { error: { code: 'ABORTED', message: 'aborted' } })
    });
    return { trace, hits: null };
  }

  /** Les moteurs, selon le mode : `want` réponses utiles au plus, les suivants en relève. */
  async function runProviders(request, signal) {
    const want = mode === 'fuse' ? fuseCount : 1;
    const queue = [...providers];
    const results = new Map();
    const traces = [];
    let active = [];
    const useful = () => [...results.values()].filter((hits) => hits.length > 0 || !fallbackOnEmpty).length;
    const launch = () => {
      while (active.length < want - useful() && queue.length && !signal.aborted) {
        const provider = queue.shift();
        const run = callProvider(provider, request, signal).then((outcome) => {
          traces.push(outcome.trace);
          if (outcome.hits) results.set(provider.id, outcome.hits);
          active = active.filter((other) => other !== run);
        });
        active.push(run);
      }
    };
    launch();
    while (active.length) {
      await Promise.race(active);
      launch();
    }
    /* L'ordre de la fusion est celui de la configuration, pas celui de l'arrivée. */
    const lists = providers.filter((provider) => results.has(provider.id)).map((provider) => ({ provider: provider.id, hits: results.get(provider.id) }));
    traces.sort((a, b) => providers.findIndex((p) => p.id === a.provider) - providers.findIndex((p) => p.id === b.provider));
    return { lists, traces };
  }

  /** Refuse une adresse d'un site bloqué, ou hors des sites permis. */
  function checkDomain(url) {
    const domain = domainOf(url);
    if (!domain) return;
    if (ranking.blockDomains.some((site) => inSite(domain, site))) throw new WebSearchError(CODES.BLOCKED_DOMAIN, 'this site is blocked');
    if (allowDomains.length && !allowDomains.some((site) => inSite(domain, site))) throw new WebSearchError(CODES.BLOCKED_DOMAIN, 'this site is not in the allowed sites');
  }

  const linkAllowed = (url) => {
    const domain = domainOf(url);
    return Boolean(domain) && !ranking.blockDomains.some((site) => inSite(domain, site))
      && (!allowDomains.length || allowDomains.some((site) => inSite(domain, site)));
  };

  /** Ce que le navigateur rend, en erreur du paquet. */
  function browserError(outcome) {
    if (!outcome.ok) {
      if (outcome.code === 'busy') return new WebSearchError(CODES.BROWSE_BUSY, 'the browser is busy; try again later', { retryable: true });
      if (outcome.code === 'invalid_input') return new WebSearchError(CODES.BAD_REQUEST, 'the browser refused the request');
      return new WebSearchError(CODES.BROWSER_UNAVAILABLE, `the browser is unavailable (${String(outcome.code).slice(0, 40)})`, { retryable: Boolean(outcome.retryable) });
    }
    const result = outcome.result;
    switch (result.status) {
      case 'blocked': return new WebSearchError(CODES.BLOCKED_ADDRESS, 'the page or one of its redirects is not public');
      case 'domain_refused': return new WebSearchError(CODES.BLOCKED_DOMAIN, 'the page or one of its redirects is on a refused site');
      case 'robots_disallowed': return new WebSearchError(CODES.BROWSE_ROBOTS, "the site's robots.txt does not allow this page");
      case 'bad_status': return new WebSearchError(CODES.BAD_STATUS, `page answered ${Number(result.httpStatus) || 0}`, { status: Number(result.httpStatus) || undefined });
      case 'timeout': return new WebSearchError(CODES.BROWSE_TIMEOUT, 'the page took too long to load');
      case 'too_many_redirects': return new WebSearchError(CODES.TOO_MANY_REDIRECTS, 'too many redirects');
      case 'unsupported_type': return new WebSearchError(CODES.UNSUPPORTED_TYPE, 'this address is not a web page');
      case 'no_site_search': return new WebSearchError(CODES.NO_SITE_SEARCH, 'this site has no search the browser can use (OpenSearch or a GET search form)');
      case 'search_engine_refused': return new WebSearchError(CODES.BROWSE_REFUSED, 'search engines are queried through their API (web_search), not through their pages');
      default: return new WebSearchError(CODES.BROWSE_FAILED, 'the browser could not read the page');
    }
  }

  /** Le résultat du navigateur, en page du paquet. */
  function browsedPage(result, asked) {
    const fullText = String(result.text || '');
    const text = fullText.length > reading.maxChars ? clip(fullText, reading.maxChars) : fullText;
    const finalUrl = parseHttpsOr(result.finalUrl, asked);
    const pageCanonical = result.canonical && sameSite(result.canonical, finalUrl) ? canonicalUrl(result.canonical) : null;
    return {
      url: asked,
      finalUrl,
      redirects: [],
      canonicalUrl: pageCanonical || canonicalUrl(finalUrl),
      domain: domainOf(finalUrl),
      title: String(result.title || ''),
      lang: result.lang || null,
      publishedAt: result.publishedAt || null,
      modifiedAt: result.modifiedAt || null,
      text,
      truncated: Boolean(result.truncated) || text.length < fullText.length,
      bytes: null,
      via: 'browser'
    };
  }

  /** Les liens rendus par le navigateur : sites bloqués ou hors des sites permis retirés, renumérotés. */
  function browsedLinks(result) {
    return (Array.isArray(result.links) ? result.links : [])
      .filter((link) => link && typeof link.url === 'string' && canonicalUrl(link.url) && linkAllowed(link.url))
      .map((link, index) => ({ n: index + 1, url: link.url, text: String(link.text || '').replace(/\s+/g, ' ').trim().slice(0, 120), sameSite: Boolean(link.sameSite) }));
  }

  const browserPolicy = () => ({
    ...(allowDomains.length ? { allowDomains } : {}),
    ...(ranking.blockDomains.length ? { blockDomains: ranking.blockDomains } : {})
  });

  /** Une page ouverte par le navigateur, en cache comme les lectures. */
  async function openWithBrowser(url, { signal, lang, screenshot = false } = {}) {
    const key = `ws:browse:${hash(canonicalUrl(url))}`;
    if (!screenshot) {
      const cached = await cacheGet(key);
      if (cached && cached.page) return { ...cached, cached: true };
    }
    const outcome = await browser.open({ url, ...(screenshot ? { screenshot: true } : {}), ...(lang && /^[a-z]{2}$/.test(lang) ? { lang } : {}), ...browserPolicy() }, { signal });
    if (!outcome.ok || outcome.result?.status !== 'ok') throw browserError(outcome);
    const value = { page: browsedPage(outcome.result, url), links: browsedLinks(outcome.result) };
    await cacheSet(key, value, readCacheTtlMs);
    return { ...value, cached: false, screenshot: outcome.result.screenshot || null };
  }

  /**
   * Lit une page : le texte principal, sa date, et les passages cités mot pour mot.
   * @param {string} url
   * @param {{ quotes?: string[], query?: string, passages?: number, signal?: AbortSignal }} [readOptions]
   */
  async function read(url, readOptions = {}) {
    const started = now();
    checkUrl(url, reading.ports || SAFE_FETCH_DEFAULTS.ports);
    checkDomain(url);
    const quotes = (Array.isArray(readOptions.quotes) ? readOptions.quotes : []).filter((quote) => typeof quote === 'string' && quote.trim()).slice(0, MAX_QUOTES);
    let page;
    let cached;
    if (browserMode === 'always') {
      const opened = await openWithBrowser(url, { signal: readOptions.signal, lang: readOptions.lang });
      page = opened.page;
      cached = opened.cached;
    } else {
      const key = `ws:read:${hash(canonicalUrl(url))}`;
      page = await cacheGet(key);
      cached = Boolean(page);
      if (!page) {
        page = await fetchPage(url, readOptions);
        await cacheSet(key, page, readCacheTtlMs);
      }
      /* Une page construite en JavaScript donne presque rien sans navigateur : il prend le relais. */
      if (browserMode === 'fallback' && wordCount(page.text) < reading.minWords) {
        try {
          const opened = await openWithBrowser(url, { signal: readOptions.signal, lang: readOptions.lang });
          if (wordCount(opened.page.text) > wordCount(page.text)) {
            page = opened.page;
            cached = opened.cached;
          }
        } catch (_error) {
          /* le navigateur en panne, refusé ou bloqué : la lecture simple reste */
        }
      }
    }
    checkDomain(page.finalUrl);
    const passageCount = readOptions.passages ?? reading.passages;
    return {
      ...page,
      via: page.via || 'fetch',
      sameSite: sameSite(url, page.finalUrl),
      quotes: quotes.map((quote) => findQuote(page.text, quote)),
      passages: readOptions.query ? bestPassages(page.text, readOptions.query, { count: passageCount, size: reading.passageSize }) : [],
      report: { ms: now() - started, cached }
    };
  }

  /** La lecture simple (sans JavaScript) d'une page. */
  async function fetchPage(url, readOptions) {
    const fetched = await safeFetch(url, {
      timeoutMs: reading.timeoutMs,
      maxBytes: reading.maxBytes,
      maxRedirects: reading.maxRedirects,
      ports: reading.ports,
      userAgent: reading.userAgent,
      lang: readOptions.lang,
      signal: readOptions.signal,
      request: options.request,
      resolve: options.resolve
    });
    const extracted = fetched.contentType === 'text/plain'
      ? { title: '', text: fetched.body.replace(/\r\n?/g, '\n').trim() }
      : (await extract(fetched.body, { url: fetched.finalUrl, now: now() })) || { text: '' };
    const fullText = String(extracted.text || '');
    const text = fullText.length > reading.maxChars ? clip(fullText, reading.maxChars) : fullText;
    const pageCanonical = extracted.canonical && sameSite(extracted.canonical, fetched.finalUrl) ? canonicalUrl(extracted.canonical) : null;
    return {
      url: fetched.url,
      finalUrl: fetched.finalUrl,
      redirects: fetched.redirects,
      canonicalUrl: pageCanonical || canonicalUrl(fetched.finalUrl),
      domain: domainOf(fetched.finalUrl),
      title: String(extracted.title || ''),
      lang: extracted.lang || null,
      publishedAt: extracted.publishedAt || null,
      modifiedAt: extracted.modifiedAt || null,
      text,
      truncated: fetched.truncated || text.length < fullText.length,
      bytes: fetched.bytes,
      via: 'fetch'
    };
  }

  function requireBrowser(name) {
    if (!browser) throw new WebSearchError(CODES.BROWSER_UNAVAILABLE, `${name} needs the integrated browser (createWebSearch({ browser }))`);
  }

  /**
   * Ouvre une page dans le navigateur : son texte rendu, ses liens numérotés,
   * et sa capture d'écran si on la demande.
   * @param {string} url
   * @param {{ screenshot?: boolean, quotes?: string[], query?: string, passages?: number, lang?: string, signal?: AbortSignal }} [browseOptions]
   */
  async function browse(url, browseOptions = {}) {
    requireBrowser('browse');
    const started = now();
    checkUrl(url, reading.ports || SAFE_FETCH_DEFAULTS.ports);
    checkDomain(url);
    const opened = await openWithBrowser(url, { signal: browseOptions.signal, lang: browseOptions.lang, screenshot: browseOptions.screenshot === true });
    return finishBrowsed(url, opened, browseOptions, started);
  }

  function finishBrowsed(url, opened, extra, started) {
    const { page } = opened;
    const quotes = (Array.isArray(extra.quotes) ? extra.quotes : []).filter((quote) => typeof quote === 'string' && quote.trim()).slice(0, MAX_QUOTES);
    return {
      ...page,
      sameSite: sameSite(url, page.finalUrl),
      links: opened.links,
      ...(opened.screenshot ? { screenshot: opened.screenshot } : {}),
      quotes: quotes.map((quote) => findQuote(page.text, quote)),
      passages: extra.query ? bestPassages(page.text, extra.query, { count: extra.passages ?? reading.passages, size: reading.passageSize }) : [],
      report: { ms: now() - started, cached: Boolean(opened.cached) }
    };
  }

  /**
   * La recherche interne d'un site (OpenSearch ou formulaire GET), sans clic.
   * @param {string} url    une page du site.
   * @param {string} query
   * @param {{ screenshot?: boolean, passages?: number, lang?: string, signal?: AbortSignal }} [searchOptions]
   */
  async function searchSite(url, query, searchOptions = {}) {
    requireBrowser('searchSite');
    const started = now();
    checkUrl(url, reading.ports || SAFE_FETCH_DEFAULTS.ports);
    checkDomain(url);
    if (typeof query !== 'string' || !query.trim()) throw new WebSearchError(CODES.BAD_REQUEST, 'searchSite needs a query');
    const outcome = await browser.siteSearch({
      url,
      query: query.trim().slice(0, 200),
      ...(searchOptions.screenshot === true ? { screenshot: true } : {}),
      ...(searchOptions.lang && /^[a-z]{2}$/.test(searchOptions.lang) ? { lang: searchOptions.lang } : {}),
      ...browserPolicy()
    }, { signal: searchOptions.signal });
    if (!outcome.ok || outcome.result?.status !== 'ok') throw browserError(outcome);
    const result = outcome.result;
    const opened = { page: browsedPage(result, result.searchUrl || url), links: browsedLinks(result), screenshot: result.screenshot || null, cached: false };
    checkDomain(opened.page.finalUrl);
    return {
      ...finishBrowsed(url, opened, { query, passages: searchOptions.passages }, started),
      siteSearch: { query: query.trim().slice(0, 200), via: result.via, searchUrl: result.searchUrl }
    };
  }

  /**
   * @param {string|object} input  la requête, ou { query, lang, country, freshness, sites, excludeSites, limit, read }.
   * @param {{ signal?: AbortSignal }} [callOptions]
   */
  async function search(input, callOptions = {}) {
    const started = now();
    const budget = globalThis.AbortSignal.timeout(budgetMs);
    const signal = callOptions.signal ? globalThis.AbortSignal.any([callOptions.signal, budget]) : budget;
    let request = normalizeRequest(input, { now: now(), lang: options.lang, country: options.country, limit: options.limit });
    const originalQuery = request.query;
    if (typeof options.rewrite === 'function') {
      try {
        const rewritten = await options.rewrite({ ...request });
        const query = typeof rewritten === 'string' ? rewritten : rewritten?.query;
        if (typeof query === 'string' && query.trim() && query.trim() !== request.query) {
          const base = typeof input === 'string' ? {} : input;
          const again = normalizeRequest({ ...base, query, sites: request.sites, excludeSites: request.excludeSites }, { now: now(), lang: request.lang, country: request.country, limit: request.limit });
          request = { ...again, recency: request.recency.wanted ? request.recency : again.recency };
        }
      } catch (_error) {
        /* une réécriture en panne garde la requête d'origine */
      }
    }

    const { lists, traces } = await runProviders(request, signal);
    const report = {
      query: originalQuery,
      ...(request.query !== originalQuery ? { rewrittenQuery: request.query } : {}),
      mode,
      recency: request.recency,
      providers: traces,
      providersUsed: lists.map((list) => list.provider),
      costUsd: 0,
      costComplete: true,
      dropped: { domain: 0, freshness: 0, perDomain: 0, duplicate: 0, otherSite: 0 },
      reads: [],
      ms: 0
    };
    for (const trace of traces) {
      if (!trace.ok || trace.cached) continue;
      if (trace.costUsd === null || trace.costUsd === undefined) report.costComplete = false;
      else report.costUsd += trace.costUsd;
    }
    report.costUsd = Math.round(report.costUsd * 1e6) / 1e6;
    if (!lists.length) {
      report.ms = now() - started;
      notify(report);
      if (callOptions.signal?.aborted) throw callOptions.signal.reason;
      const error = new WebSearchError(CODES.ALL_FAILED, budget.aborted ? 'search ran out of time' : 'no search provider answered');
      error.report = report;
      throw error;
    }

    const fused = fuseRankings(lists);
    const ranked = rankEntries(fused, request, { ...ranking, now: now() });
    Object.assign(report.dropped, ranked.dropped);
    let entries = ranked.entries.slice(0, request.limit);

    const toRead = Math.max(0, Math.min(MAX_READ, Math.floor(Number(input?.read) || 0)));
    if (toRead > 0 && !signal.aborted) {
      const targets = entries.slice(0, toRead);
      const pages = await Promise.all(targets.map(async (entry) => {
        const begun = now();
        try {
          const page = await read(entry.url, { query: request.query, signal, lang: request.lang });
          report.reads.push({ url: entry.url, ok: true, ms: now() - begun, cached: page.report.cached });
          return page;
        } catch (error) {
          report.reads.push({ url: entry.url, ok: false, ms: now() - begun, error: { code: error.code || CODES.READ_FAILED, message: error instanceof WebSearchError ? error.message : 'read failed' } });
          return null;
        }
      }));
      targets.forEach((entry, index) => {
        const page = pages[index];
        if (!page) {
          entry.page = { status: 'failed' };
          return;
        }
        if (!page.sameSite) {
          /* Redirigée vers un autre site : ce texte n'est pas celui de cette entrée. */
          entry.page = { status: 'other_site', finalUrl: page.finalUrl };
          report.dropped.otherSite += 1;
          return;
        }
        entry.page = {
          status: 'read',
          finalUrl: page.finalUrl,
          canonicalUrl: page.canonicalUrl,
          title: page.title,
          lang: page.lang,
          publishedAt: page.publishedAt,
          truncated: page.truncated,
          passages: page.passages.map(({ text, start, end }) => ({ text, start, end }))
        };
        if (!entry.publishedAt && page.publishedAt) {
          entry.publishedAt = page.publishedAt;
          entry.dateSource = 'page';
        }
      });
      /* Deux pages LUES qui se déclarent la même page canonique (du même site) : une
         seule entrée. Une page lue ne peut pas, par sa déclaration, faire disparaître
         un résultat qui n'a pas été lu. */
      const seen = new Set();
      entries = entries.filter((entry) => {
        const key = entry.page?.status === 'read' ? `read ${entry.page.canonicalUrl}` : `entry ${entry.canonicalUrl}`;
        if (seen.has(key)) {
          report.dropped.duplicate += 1;
          return false;
        }
        seen.add(key);
        return true;
      });
    }

    const results = entries.map((entry, index) => ({
      id: `S${index + 1}`,
      title: entry.title,
      url: entry.url,
      canonicalUrl: entry.canonicalUrl,
      domain: entry.domain,
      publishedAt: entry.publishedAt,
      dateSource: entry.dateSource,
      snippet: entry.snippet,
      ...(entry.extraSnippets.length ? { extraSnippets: entry.extraSnippets } : {}),
      snippetFrom: entry.snippetFrom,
      foundBy: entry.foundBy,
      ranks: entry.ranks,
      score: Math.round(entry.score * 1e5) / 1e5,
      ...(entry.page ? { page: entry.page } : {})
    }));
    report.ms = now() - started;
    notify(report);
    return { query: originalQuery, request, results, report, searchedAt: new Date(now()).toISOString() };
  }

  function notify(report) {
    if (typeof options.onReport !== 'function') return;
    try {
      options.onReport(report);
    } catch (_error) {
      /* le compte rendu ne casse jamais la recherche */
    }
  }

  return { search, read, browse, searchSite, hasBrowser: Boolean(browser), providerIds: providers.map((provider) => provider.id) };
}

module.exports = { createWebSearch };
