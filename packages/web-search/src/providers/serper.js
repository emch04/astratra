/**
 * Serper (résultats Google), par `searchSerper` de @astratra/ai : le même
 * adaptateur sert les deux paquets, il n'est pas réécrit ici.
 */

const { searchSerper } = require('@astratra/ai');
const { WebSearchError, CODES, providerFailure } = require('../errors');
const { readKey } = require('./http');
const { parseDate } = require('../dates');

/**
 * @param {object} options
 * @param {string|Function} options.key  la clé Serper, ou une fonction qui la donne.
 * @param {Function} [options.fetch]
 * @param {string} [options.endpoint]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.costPerCallUsd] Défaut 0,001 $ (estimation, à régler selon le forfait).
 * @param {string} [options.id] Défaut 'serper'.
 */
function serperProvider(options = {}) {
  const id = options.id || 'serper';
  return {
    id,
    costPerCallUsd: options.costPerCallUsd ?? 0.001,
    cacheTtlMs: options.cacheTtlMs,
    async search(request, { signal, now = Date.now() } = {}) {
      const key = await readKey(options.key);
      if (!key) throw new WebSearchError(CODES.PROVIDER_FAILED, `${id} has no key`, { provider: id });
      /* Les exclusions vont dans la requête ; les sites, dans le paramètre de searchSerper. */
      const query = [request.query, ...request.excludeSites.map((site) => `-site:${site}`)].join(' ');
      const fetch = options.fetch || globalThis.fetch;
      const guarded = signal ? (url, init) => fetch(url, { ...init, signal: globalThis.AbortSignal.any([signal, init.signal]) }) : fetch;
      let found;
      try {
        found = await searchSerper(
          { query, sites: request.sites, num: request.limit > 10 ? 20 : 10, ...(request.lang ? { hl: request.lang } : {}), ...(request.country ? { gl: request.country } : {}), ...(request.freshness ? { period: request.freshness } : {}) },
          { key, fetch: guarded, timeoutMs: options.timeoutMs, endpoint: options.endpoint }
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw providerFailure(id, { status: error.status, cause: { message: 'network' }, secrets: [key] });
      }
      return {
        hits: found.map((result) => ({
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          publishedAt: parseDate(result.date, { now })
        }))
      };
    }
  };
}

module.exports = { serperProvider };
