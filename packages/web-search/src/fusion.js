/**
 * La fusion des classements de plusieurs moteurs, SANS fusion des contenus.
 *
 * Reciprocal Rank Fusion (Cormack, Clarke et Büttcher, 2009) : une page gagne
 * 1 / (k + rang) dans chaque liste où elle paraît. Seul le CLASSEMENT est
 * fusionné. Le texte d'une entrée (titre, extrait, extraits en plus) vient d'un
 * seul moteur, celui qui l'a le mieux classée, et `snippetFrom` le nomme : deux
 * extraits de deux moteurs ne sont jamais collés ensemble, même pour la même page.
 *
 * Une entrée = une page canonique = un site. Deux adresses qui mènent à la
 * même page canonique ne font qu'une entrée ; deux pages différentes ne sont
 * jamais réunies, même si leur texte se ressemble.
 */

const { canonicalUrl, domainOf, inSite } = require('./url');
const { ageInDays } = require('./dates');
const { FRESHNESS_DAYS } = require('./query');

const DEFAULT_K = 60;

/**
 * @param {{ provider: string, hits: object[], weight?: number }[]} lists dans l'ordre de préférence des moteurs.
 * @param {{ k?: number }} [options]
 * @returns {object[]} les entrées, de la mieux classée à la moins bien classée.
 */
function fuseRankings(lists, { k = DEFAULT_K } = {}) {
  const entries = new Map();
  lists.forEach(({ provider, hits, weight = 1 }, listIndex) => {
    const seenHere = new Set();
    (hits || []).forEach((hit, index) => {
      const canonical = canonicalUrl(hit.url);
      if (!canonical || seenHere.has(canonical)) return;
      seenHere.add(canonical);
      const rank = index + 1;
      const gain = weight / (k + rank);
      const entry = entries.get(canonical);
      if (!entry) {
        entries.set(canonical, {
          canonicalUrl: canonical,
          url: hit.url,
          domain: domainOf(canonical),
          title: hit.title,
          snippet: hit.snippet || '',
          extraSnippets: Array.isArray(hit.extraSnippets) ? [...hit.extraSnippets] : [],
          snippetFrom: provider,
          publishedAt: hit.publishedAt || null,
          dateSource: hit.publishedAt ? provider : null,
          foundBy: [provider],
          ranks: { [provider]: rank },
          score: gain,
          bestRank: rank,
          bestList: listIndex
        });
        return;
      }
      entry.score += gain;
      entry.foundBy.push(provider);
      entry.ranks[provider] = rank;
      /* Le texte suit le moteur qui a le mieux classé la page, en entier : titre,
         adresse, extraits et date de ce moteur, jamais un mélange. */
      if (rank < entry.bestRank || (rank === entry.bestRank && listIndex < entry.bestList)) {
        entry.url = hit.url;
        entry.title = hit.title;
        entry.snippet = hit.snippet || '';
        entry.extraSnippets = Array.isArray(hit.extraSnippets) ? [...hit.extraSnippets] : [];
        entry.snippetFrom = provider;
        if (hit.publishedAt) {
          entry.publishedAt = hit.publishedAt;
          entry.dateSource = provider;
        }
        entry.bestRank = rank;
        entry.bestList = listIndex;
      } else if (!entry.publishedAt && hit.publishedAt) {
        /* Une date donnée par un autre moteur pour LA MÊME page : on la garde, en le disant. */
        entry.publishedAt = hit.publishedAt;
        entry.dateSource = provider;
      }
    });
  });
  return [...entries.values()]
    .sort((a, b) => (b.score - a.score) || (a.bestRank - b.bestRank) || (a.bestList - b.bestList))
    .map(({ bestRank: _r, bestList: _l, ...entry }) => entry);
}

/**
 * Le classement final : filtres de sites, fraîcheur, qualité des domaines, plafond par site.
 *
 * @param {object[]} entries sortie de fuseRankings
 * @param {object} request  sortie de normalizeRequest
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {string[]} [options.blockDomains]   jamais rendus.
 * @param {string[]} [options.preferDomains]  score × 1,5.
 * @param {string[]} [options.demoteDomains]  score × 0,5.
 * @param {Function} [options.domainScore]    (domain) => multiplicateur (≥ 0 ; 0 écarte).
 * @param {number} [options.maxPerDomain]     Défaut 2.
 * @returns {{ entries: object[], dropped: { domain: number, freshness: number, perDomain: number } }}
 */
function rankEntries(entries, request, options = {}) {
  const now = options.now ?? Date.now();
  const block = options.blockDomains || [];
  const prefer = options.preferDomains || [];
  const demote = options.demoteDomains || [];
  const maxPerDomain = options.maxPerDomain ?? 2;
  const dropped = { domain: 0, freshness: 0, perDomain: 0 };
  const limitDays = request.freshness ? FRESHNESS_DAYS[request.freshness] + 1 : null;

  const scored = [];
  for (const entry of entries) {
    const domain = entry.domain;
    const blocked = block.some((site) => inSite(domain, site))
      || request.excludeSites.some((site) => inSite(domain, site))
      || (request.sites.length > 0 && !request.sites.some((site) => inSite(domain, site)));
    if (blocked) {
      dropped.domain += 1;
      continue;
    }
    const age = ageInDays(entry.publishedAt, now);
    if (limitDays !== null && age !== null && age > limitDays) {
      dropped.freshness += 1;
      continue;
    }
    let factor = 1;
    if (prefer.some((site) => inSite(domain, site))) factor *= 1.5;
    if (demote.some((site) => inSite(domain, site))) factor *= 0.5;
    if (typeof options.domainScore === 'function') {
      const value = Number(options.domainScore(domain));
      if (Number.isFinite(value) && value >= 0) factor *= value;
    }
    if (factor === 0) {
      dropped.domain += 1;
      continue;
    }
    /* Récent d'abord quand la question le veut : un bonus qui décroît avec l'âge
       (×2 aujourd'hui, ×1,5 à une semaine…) ; une page sans date n'en a pas. */
    if (request.recency?.wanted && age !== null) factor *= 1 + 1 / (1 + age / 7);
    scored.push({ ...entry, score: entry.score * factor });
  }
  scored.sort((a, b) => b.score - a.score);

  const perDomain = new Map();
  const kept = [];
  for (const entry of scored) {
    const count = perDomain.get(entry.domain) || 0;
    if (count >= maxPerDomain) {
      dropped.perDomain += 1;
      continue;
    }
    perDomain.set(entry.domain, count + 1);
    kept.push(entry);
  }
  return { entries: kept, dropped };
}

module.exports = { fuseRankings, rankEntries, RRF_K: DEFAULT_K };
