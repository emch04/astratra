/**
 * Brave Search (Web Search API) : un index indépendant de Google, ce qui donne
 * à la fusion une vraie seconde opinion.
 *
 * GET https://api.search.brave.com/res/v1/web/search, clé dans
 * `X-Subscription-Token`. `count` au plus 20, `freshness` pd/pw/pm/py,
 * `extra_snippets` (jusqu'à 5 extraits de plus, tous de la même page).
 * Les descriptions portent du HTML (<strong>) : il est retiré.
 *
 * Les conditions de Brave réservent le stockage des résultats aux forfaits qui
 * l'incluent : le cache de ce fournisseur est court par défaut (1 minute).
 */

const { WebSearchError, CODES } = require('../errors');
const { requestJson, readKey } = require('./http');
const { withOperators } = require('../query');
const { plainText } = require('../text');
const { parseDate } = require('../dates');

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const FRESHNESS = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

/**
 * @param {object} options
 * @param {string|Function} options.key
 * @param {Function} [options.fetch]
 * @param {boolean} [options.extraSnippets] Défaut true.
 * @param {string} [options.safesearch] 'off' | 'moderate' | 'strict'. Défaut 'moderate'.
 * @param {number} [options.costPerCallUsd] Défaut 0,005 $ (5 $ les 1 000 requêtes).
 * @param {number} [options.cacheTtlMs] Défaut 60 000.
 */
function braveProvider(options = {}) {
  const id = options.id || 'brave';
  return {
    id,
    costPerCallUsd: options.costPerCallUsd ?? 0.005,
    cacheTtlMs: options.cacheTtlMs ?? 60_000,
    async search(request, { signal, now = Date.now() } = {}) {
      const key = await readKey(options.key);
      if (!key) throw new WebSearchError(CODES.PROVIDER_FAILED, `${id} has no key`, { provider: id });
      const params = new globalThis.URLSearchParams({
        q: withOperators(request),
        count: String(Math.min(20, Math.max(request.limit, 10))),
        safesearch: options.safesearch || 'moderate'
      });
      if (options.extraSnippets !== false) params.set('extra_snippets', 'true');
      if (request.country) params.set('country', request.country.toUpperCase());
      if (request.lang) params.set('search_lang', request.lang);
      if (request.freshness) params.set('freshness', FRESHNESS[request.freshness]);
      const answer = await requestJson(id, {
        fetch: options.fetch || globalThis.fetch,
        url: `${options.endpoint || ENDPOINT}?${params}`,
        init: { method: 'GET', headers: { accept: 'application/json', 'X-Subscription-Token': key } },
        secrets: [key],
        signal,
        timeoutMs: options.timeoutMs
      });
      const results = Array.isArray(answer?.web?.results) ? answer.web.results : [];
      return {
        hits: results.map((result) => ({
          title: plainText(result?.title),
          url: String(result?.url ?? ''),
          snippet: plainText(result?.description),
          extraSnippets: Array.isArray(result?.extra_snippets) ? result.extra_snippets.map(plainText).filter(Boolean).slice(0, 5) : [],
          publishedAt: parseDate(result?.page_age, { now }) || parseDate(result?.age, { now })
        }))
      };
    }
  };
}

module.exports = { braveProvider };
