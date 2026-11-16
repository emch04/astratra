/* global AbortController */

/**
 * Le client du navigateur intégré, et le même moteur dans le processus.
 *
 * `createBrowserClient({ baseUrl, token })` appelle le service
 * `astratra-web-browser`, sans dépendance. Comme le client de
 * `@astratra/models`, il ne lève jamais : chaque appel rend
 *   { ok: true, result }  ou  { ok: false, code, retryable, status?, message? }
 * et `result.status` dit ce qu'est devenue la page (ok, robots_disallowed,
 * blocked…). Délai par appel, nouvel essai sur panne réseau ou service
 * occupé, disjoncteur : un service arrêté coûte un refus rapide, pas un délai
 * par lecture.
 *
 * `createLocalBrowser(options)` : le moteur dans le processus (Playwright
 * requis), pour le développement et les tests ; même interface.
 */

const fs = require('fs');
const { createBrowserEngine } = require('./engine');

const OUTAGES = new Set(['timeout', 'network_error', 'server_error', 'unavailable', 'bad_response', 'unauthorized', 'token_unavailable']);
const RETRYABLE = new Set(['network_error', 'busy', 'unavailable']);

/** Un disjoncteur : `failureThreshold` pannes de suite l'ouvrent `recoveryMs`, puis un seul essai passe. */
function createBreaker({ failureThreshold = 3, recoveryMs = 30_000, now = Date.now, onChange = () => {} } = {}) {
  let state = 'closed';
  let failures = 0;
  let openedAt = 0;
  let probing = false;
  const move = (to) => {
    if (state === to) return;
    const from = state;
    state = to;
    try {
      onChange({ from, to });
    } catch (_error) {
      /* un observateur ne casse rien */
    }
  };
  return {
    /** Vrai si un appel peut partir maintenant. */
    allow() {
      if (state === 'open') {
        if (now() - openedAt < recoveryMs) return false;
        move('half-open');
      }
      if (state === 'half-open') {
        if (probing) return false;
        probing = true;
      }
      return true;
    },
    success() {
      failures = 0;
      probing = false;
      move('closed');
    },
    failure() {
      probing = false;
      if (state === 'half-open') {
        openedAt = now();
        move('open');
        return;
      }
      failures += 1;
      if (failures >= failureThreshold) {
        openedAt = now();
        move('open');
      }
    },
    /* Une réponse qui n'est pas une panne libère l'essai sans fermer ni ouvrir. */
    neutral() {
      probing = false;
      if (state === 'half-open') move('closed');
    },
    status: () => ({ state, failures })
  };
}

function normaliseBaseUrl(value) {
  const raw = value || 'http://127.0.0.1:5008';
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new TypeError('createBrowserClient: baseUrl must be an absolute http(s) URL.', { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('createBrowserClient: baseUrl must be an absolute http(s) URL.');
  return raw.replace(/\/+$/, '');
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl]           Défaut http://127.0.0.1:5008.
 * @param {string|Function} [options.token]    le jeton, ou une fonction (async) qui le rend.
 * @param {string} [options.tokenFile]         ou un fichier, relu à chaque appel.
 * @param {Function} [options.fetch]           Défaut globalThis.fetch.
 * @param {number} [options.timeoutMs]         Défaut 30 s (le service s'arrête à 25 s).
 * @param {{ attempts?: number, baseDelayMs?: number, maxDelayMs?: number }} [options.retry]  Défaut 2 essais.
 * @param {{ failureThreshold?: number, recoveryMs?: number }|false} [options.breaker]
 * @param {Function} [options.onEvent]         ({ type, … }) => void.
 */
function createBrowserClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('createBrowserClient: a fetch function is required.');
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const attempts = Math.max(1, Math.floor(options.retry?.attempts ?? 2));
  const baseDelayMs = options.retry?.baseDelayMs ?? 250;
  const maxDelayMs = options.retry?.maxDelayMs ?? 1_500;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random || Math.random;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const emit = (event) => {
    try {
      onEvent(event);
    } catch (_error) {
      /* un observateur ne casse rien */
    }
  };
  const breaker = options.breaker === false ? null : createBreaker({ ...(options.breaker || {}), now: options.now, onChange: ({ from, to }) => emit({ type: 'breaker', from, to }) });

  async function token() {
    if (typeof options.token === 'function') return options.token();
    if (typeof options.token === 'string') return options.token;
    if (options.tokenFile) return (await fs.promises.readFile(options.tokenFile, 'utf8')).trim();
    return null;
  }

  const refuse = (code, extra = {}) => ({ ok: false, code, retryable: RETRYABLE.has(code), ...extra });

  async function exchange(method, path, body, signal) {
    if (signal?.aborted) return refuse('aborted');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      let secret;
      try {
        secret = await token();
      } catch (_error) {
        return refuse('token_unavailable');
      }
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal
        });
      } catch (_error) {
        if (timedOut) return refuse('timeout');
        if (signal?.aborted) return refuse('aborted');
        return refuse('network_error');
      }
      let data = null;
      try {
        data = await response.json();
      } catch (_error) {
        if (timedOut) return refuse('timeout');
        if (signal?.aborted) return refuse('aborted');
        return refuse('bad_response', { status: response.status });
      }
      if (response.status >= 200 && response.status < 300) {
        if (!data || typeof data !== 'object') return refuse('bad_response', { status: response.status });
        return { ok: true, result: data };
      }
      const code = typeof data?.error?.code === 'string' ? data.error.code : null;
      const message = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 200) : undefined;
      const extra = { status: response.status, ...(message ? { message } : {}) };
      if (response.status === 400) return refuse('invalid_input', extra);
      if (response.status === 401 || response.status === 403) return refuse('unauthorized', extra);
      if (response.status === 404 || response.status === 405) return refuse('not_found', extra);
      if (response.status === 413 || response.status === 415) return refuse('invalid_input', extra);
      if (response.status === 503) return refuse(code === 'busy' ? 'busy' : code === 'token_unavailable' ? 'token_unavailable' : 'unavailable', extra);
      return refuse('server_error', extra);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async function call(name, method, path, body, signal) {
    if (breaker && !breaker.allow()) return refuse('circuit_open');
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await exchange(method, path, body, signal);
      if (last.ok || !last.retryable || attempt === attempts || signal?.aborted) break;
      emit({ type: 'retry', endpoint: name, code: last.code, attempt });
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * random());
    }
    if (breaker) {
      if (last.ok) breaker.success();
      else if (OUTAGES.has(last.code)) breaker.failure();
      else breaker.neutral();
    }
    emit({ type: 'call', endpoint: name, ok: last.ok, ...(last.ok ? { status: last.result.status } : { code: last.code }) });
    return last;
  }

  return {
    /** @param {{ url: string, screenshot?: boolean, waitFor?: string, allowDomains?: string[], blockDomains?: string[], lang?: string }} request */
    open: (request, { signal } = {}) => call('open', 'POST', '/v1/open', request, signal),
    /** @param {{ url: string, query: string, screenshot?: boolean, allowDomains?: string[], blockDomains?: string[], lang?: string }} request */
    siteSearch: (request, { signal } = {}) => call('site-search', 'POST', '/v1/site-search', request, signal),
    health: ({ signal } = {}) => call('health', 'GET', '/health', undefined, signal),
    breakerStatus: () => breaker?.status() || null,
    kind: 'service'
  };
}

/**
 * Le moteur dans le processus, avec l'interface du client.
 * @param {object} [options]  les options de createBrowserEngine (ou `engine` déjà créé).
 */
function createLocalBrowser(options = {}) {
  const engine = options.engine || createBrowserEngine(options);
  const wrap = (result) => {
    if (result.status === 'busy') return { ok: false, code: 'busy', retryable: true };
    if (result.status === 'invalid_input') return { ok: false, code: 'invalid_input', retryable: false, message: `${result.reason || 'request'} is invalid.` };
    if (result.status === 'browser_unavailable') return { ok: false, code: 'unavailable', retryable: false, message: result.reason };
    return { ok: true, result };
  };
  return {
    open: async (request, { signal } = {}) => wrap(await engine.open(request, { signal })),
    siteSearch: async (request, { signal } = {}) => wrap(await engine.siteSearch(request, { signal })),
    health: async () => ({ ok: true, result: await engine.health() }),
    start: () => engine.start(),
    close: () => engine.close(),
    kind: 'local'
  };
}

module.exports = { createBrowserClient, createLocalBrowser };
