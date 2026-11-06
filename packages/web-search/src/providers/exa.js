/**
 * Exa : une recherche par le sens, avec la date de publication estimée et des
 * passages (`highlights`) tirés de la page elle-même.
 *
 * POST https://api.exa.ai/search, clé dans `x-api-key`. Domaines à inclure ou
 * exclure, `startPublishedDate` pour la fraîcheur, `userLocation` pour le pays.
 * La réponse porte `costDollars.total`, une estimation que le compte rendu
 * reprend telle quelle. Le résumé généré d'Exa (`summary`) n'est jamais demandé.
 */

const { WebSearchError, CODES } = require('../errors');
const { requestJson, readKey } = require('./http');
const { plainText } = require('../text');
const { parseDate } = require('../dates');
const { FRESHNESS_DAYS } = require('../query');

const ENDPOINT = 'https://api.exa.ai/search';

/**
 * @param {object} options
 * @param {string|Function} options.key
 * @param {Function} [options.fetch]
 * @param {'auto'|'fast'|'deep'} [options.type] Défaut 'auto'.
 * @param {number} [options.highlightChars] taille des passages demandés. Défaut 400.
 * @param {number} [options.costPerCallUsd] utilisé quand Exa ne donne pas `costDollars`. Défaut 0,007 $.
 */
function exaProvider(options = {}) {
  const id = options.id || 'exa';
  return {
    id,
    costPerCallUsd: options.costPerCallUsd ?? 0.007,
    cacheTtlMs: options.cacheTtlMs,
    async search(request, { signal, now = Date.now() } = {}) {
      const key = await readKey(options.key);
      if (!key) throw new WebSearchError(CODES.PROVIDER_FAILED, `${id} has no key`, { provider: id });
      const body = {
        query: request.query,
        type: options.type || 'auto',
        numResults: Math.min(20, Math.max(request.limit, 10)),
        contents: { highlights: { maxCharacters: options.highlightChars || 400 } },
        ...(request.sites.length ? { includeDomains: request.sites } : {}),
        ...(request.excludeSites.length ? { excludeDomains: request.excludeSites } : {}),
        ...(request.freshness ? { startPublishedDate: new Date(now - FRESHNESS_DAYS[request.freshness] * 86_400_000).toISOString() } : {}),
        ...(request.country ? { userLocation: request.country.toUpperCase() } : {})
      };
      const answer = await requestJson(id, {
        fetch: options.fetch || globalThis.fetch,
        url: options.endpoint || ENDPOINT,
        init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) },
        secrets: [key],
        signal,
        timeoutMs: options.timeoutMs
      });
      const results = Array.isArray(answer?.results) ? answer.results : [];
      const cost = Number(answer?.costDollars?.total);
      return {
        hits: results.map((result) => {
          const highlights = Array.isArray(result?.highlights) ? result.highlights.map(plainText).filter(Boolean) : [];
          return {
            title: plainText(result?.title),
            url: String(result?.url ?? ''),
            snippet: highlights[0] || '',
            extraSnippets: highlights.slice(1, 5),
            publishedAt: parseDate(result?.publishedDate, { now })
          };
        }),
        ...(Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {})
      };
    }
  };
}

module.exports = { exaProvider };
