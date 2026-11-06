/**
 * Tavily : une recherche faite pour les agents.
 *
 * POST https://api.tavily.com/search, `Authorization: Bearer`. Filtres de
 * domaines natifs, `time_range`, `published_date` (demandé par
 * `include_published_date`). `search_depth` est fixé à `basic` (1 crédit) :
 * sans lui, le réglage automatique de Tavily peut passer en `advanced`
 * (2 crédits). La réponse générée de Tavily (`include_answer`) n'est jamais
 * demandée : ce paquet ne rend que des pages, pas une synthèse de plusieurs.
 */

const { WebSearchError, CODES } = require('../errors');
const { requestJson, readKey } = require('./http');
const { plainText } = require('../text');
const { parseDate } = require('../dates');

const ENDPOINT = 'https://api.tavily.com/search';

/* Tavily attend le nom du pays (en anglais, en minuscules), pas son code. */
const COUNTRIES = {
  fr: 'france', be: 'belgium', ch: 'switzerland', ca: 'canada', us: 'united states', gb: 'united kingdom',
  de: 'germany', es: 'spain', it: 'italy', pt: 'portugal', nl: 'netherlands', lu: 'luxembourg',
  ma: 'morocco', dz: 'algeria', tn: 'tunisia', sn: 'senegal', ci: "cote d'ivoire", cm: 'cameroon',
  cd: 'democratic republic of the congo', cg: 'congo', ga: 'gabon', ml: 'mali', bf: 'burkina faso',
  ng: 'nigeria', za: 'south africa', ke: 'kenya', in: 'india', jp: 'japan', cn: 'china', br: 'brazil',
  mx: 'mexico', ar: 'argentina', au: 'australia', nz: 'new zealand', ie: 'ireland', se: 'sweden',
  no: 'norway', dk: 'denmark', fi: 'finland', pl: 'poland', at: 'austria', gr: 'greece', tr: 'turkey'
};

/**
 * @param {object} options
 * @param {string|Function} options.key
 * @param {Function} [options.fetch]
 * @param {'basic'|'fast'|'advanced'} [options.searchDepth] Défaut 'basic'.
 * @param {number} [options.costPerCallUsd] Défaut 0,008 $ (un crédit au paiement à l'usage ; 2 en advanced).
 */
function tavilyProvider(options = {}) {
  const id = options.id || 'tavily';
  const depth = options.searchDepth || 'basic';
  return {
    id,
    costPerCallUsd: options.costPerCallUsd ?? (depth === 'advanced' ? 0.016 : 0.008),
    cacheTtlMs: options.cacheTtlMs,
    async search(request, { signal, now = Date.now() } = {}) {
      const key = await readKey(options.key);
      if (!key) throw new WebSearchError(CODES.PROVIDER_FAILED, `${id} has no key`, { provider: id });
      const body = {
        query: request.query,
        search_depth: depth,
        topic: 'general',
        max_results: Math.min(20, Math.max(request.limit, 10)),
        include_answer: false,
        include_raw_content: false,
        include_published_date: true,
        ...(request.sites.length ? { include_domains: request.sites } : {}),
        ...(request.excludeSites.length ? { exclude_domains: request.excludeSites } : {}),
        ...(request.freshness ? { time_range: request.freshness } : {}),
        ...(request.country && COUNTRIES[request.country] ? { country: COUNTRIES[request.country] } : {})
      };
      const answer = await requestJson(id, {
        fetch: options.fetch || globalThis.fetch,
        url: options.endpoint || ENDPOINT,
        init: { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) },
        secrets: [key],
        signal,
        timeoutMs: options.timeoutMs
      });
      const results = Array.isArray(answer?.results) ? answer.results : [];
      return {
        hits: results.map((result) => ({
          title: plainText(result?.title),
          url: String(result?.url ?? ''),
          snippet: plainText(result?.content),
          publishedAt: parseDate(result?.published_date, { now })
        }))
      };
    }
  };
}

module.exports = { tavilyProvider, TAVILY_COUNTRIES: COUNTRIES };
