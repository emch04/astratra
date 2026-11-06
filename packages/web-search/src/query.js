/**
 * La demande, mise au propre avant de partir vers les moteurs.
 *
 * - Les opérateurs `site:` et `-site:` écrits dans la requête deviennent des
 *   filtres : chaque moteur reçoit alors sa forme à lui (paramètre natif ou
 *   opérateur), et le filtre est réappliqué à l'arrivée, quoi qu'ait fait le moteur.
 * - La fraîcheur : `freshness` ('day', 'week', 'month', 'year') est un FILTRE
 *   demandé aux moteurs et revérifié sur les dates connues. `'auto'` (défaut)
 *   ne filtre rien : il repère les questions qui veulent du récent (« aujourd'hui »,
 *   « dernière version », l'année en cours…) et fait alors passer le récent devant.
 */

const { WebSearchError, CODES } = require('./errors');
const { normalizeSite } = require('./url');

const FRESHNESS = ['day', 'week', 'month', 'year'];
const FRESHNESS_DAYS = Object.freeze({ day: 1, week: 7, month: 31, year: 366 });
const MAX_QUERY = 400;
const MAX_SITES = 20;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

const fold = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/* Des mots qui demandent du récent, en français et en anglais. Repérés comme mots
   entiers, sur le texte sans accents. */
const RECENCY_WORDS = [
  ['day', /\b(aujourd'?hui|ce matin|ce soir|hier|en direct|today|tonight|yesterday|live|breaking)\b/],
  ['week', /\b(cette semaine|this week|actualites?|news|derniere minute)\b/],
  ['month', /\b(derniere?s?|recente?s?|recemment|actuel(le)?s?|actuellement|en ce moment|nouveaux?|nouvelles?|latest|newest|recent(ly)?|current(ly)?|right now|now|this month|ce mois)\b/]
];

/**
 * Ce que la question dit de la fraîcheur voulue, sans rien filtrer.
 * @returns {{ wanted: boolean, window: string|null, reason: string|null }}
 */
function detectRecency(query, { now = Date.now() } = {}) {
  const text = fold(query);
  for (const [window, pattern] of RECENCY_WORDS) {
    const match = text.match(pattern);
    if (match) return { wanted: true, window, reason: match[0] };
  }
  const year = new Date(now).getUTCFullYear();
  const years = text.match(/\b(19|20)\d{2}\b/g) || [];
  if (years.some((value) => Number(value) >= year)) return { wanted: true, window: 'year', reason: String(year) };
  return { wanted: false, window: null, reason: null };
}

function cleanCode(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const code = String(value).trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) throw new WebSearchError(CODES.BAD_REQUEST, `${name} must be a two-letter code`);
  return code;
}

function cleanSites(list, name) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new WebSearchError(CODES.BAD_REQUEST, `${name} must be an array of sites`);
  const sites = [];
  for (const site of list) {
    const domain = normalizeSite(site);
    if (!domain) throw new WebSearchError(CODES.BAD_REQUEST, `${name} has an invalid site`);
    if (!sites.includes(domain)) sites.push(domain);
  }
  if (sites.length > MAX_SITES) throw new WebSearchError(CODES.BAD_REQUEST, `${name} has more than ${MAX_SITES} sites`);
  return sites;
}

/**
 * @param {object} input
 * @param {{ now?: number, lang?: string, country?: string, limit?: number }} [defaults]
 * @returns {{ query: string, lang: string|null, country: string|null, freshness: string|null,
 *   recency: { wanted: boolean, window: string|null, reason: string|null }, sites: string[],
 *   excludeSites: string[], limit: number }}
 */
function normalizeRequest(input, defaults = {}) {
  const request = typeof input === 'string' ? { query: input } : (input || {});
  // eslint-disable-next-line no-control-regex -- les caractères de contrôle sont justement ceux qu'on retire
  let query = String(request.query ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  const sites = cleanSites(request.sites, 'sites');
  const excludeSites = cleanSites(request.excludeSites, 'excludeSites');

  /* Les opérateurs écrits dans la requête deviennent des filtres. */
  query = query.replace(/(^|\s)(-?)site:(\S+)/gi, (_whole, space, minus, site) => {
    const domain = normalizeSite(site);
    if (!domain) return space;
    const list = minus ? excludeSites : sites;
    if (!list.includes(domain)) list.push(domain);
    return space;
  });
  query = query.replace(/\s+/g, ' ').trim();
  if (!query) throw new WebSearchError(CODES.BAD_REQUEST, 'query is empty');
  if (query.length > MAX_QUERY) throw new WebSearchError(CODES.BAD_REQUEST, `query is longer than ${MAX_QUERY} characters`);
  if (sites.length > MAX_SITES || excludeSites.length > MAX_SITES) throw new WebSearchError(CODES.BAD_REQUEST, `more than ${MAX_SITES} sites`);

  const asked = request.freshness ?? 'auto';
  if (asked !== 'auto' && asked !== 'any' && !FRESHNESS.includes(asked)) {
    throw new WebSearchError(CODES.BAD_REQUEST, 'freshness must be auto, any, day, week, month or year');
  }
  const freshness = FRESHNESS.includes(asked) ? asked : null;
  const recency = freshness
    ? { wanted: true, window: freshness, reason: 'asked' }
    : asked === 'auto' ? detectRecency(query, { now: defaults.now }) : { wanted: false, window: null, reason: null };

  const limitValue = request.limit ?? defaults.limit ?? DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limitValue) || DEFAULT_LIMIT)));

  return {
    query,
    lang: cleanCode(request.lang ?? defaults.lang, 'lang'),
    country: cleanCode(request.country ?? defaults.country, 'country'),
    freshness,
    recency,
    sites: sites.filter((site) => !excludeSites.includes(site)),
    excludeSites,
    limit
  };
}

/** La requête avec des opérateurs, pour un moteur qui n'a pas de filtre natif. */
function withOperators(request, { includeSites = true } = {}) {
  const parts = [request.query];
  if (includeSites && request.sites.length === 1) parts.push(`site:${request.sites[0]}`);
  else if (includeSites && request.sites.length > 1) parts.push(`(${request.sites.map((site) => `site:${site}`).join(' OR ')})`);
  for (const site of request.excludeSites) parts.push(`-site:${site}`);
  return parts.join(' ');
}

module.exports = { normalizeRequest, detectRecency, withOperators, FRESHNESS, FRESHNESS_DAYS, MAX_LIMIT };
