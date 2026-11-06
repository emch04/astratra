/**
 * Une petite batterie d'évaluation : des questions types et des critères
 * qu'une machine vérifie, pour comparer l'outil à une recherche brute.
 *
 * Critères vérifiés sur chaque cas :
 * - `noMixing` : le titre et l'extrait de chaque entrée sont exactement ceux
 *   que le moteur nommé par `snippetFrom` a donnés pour CETTE page ;
 * - `noDuplicates` : pas deux entrées pour la même page canonique ;
 * - `passagesVerified` : chaque passage cité est, mot pour mot, à sa position
 *   dans le texte de sa page (`readText` donne ce texte) ;
 * - et, selon le cas : `expectedDomain` (le bon site dans les `within`
 *   premiers), `recentFirst` (la page la plus récente en tête parmi les
 *   premières datées), `forbiddenDomains` (aucun de ces sites).
 */

const { canonicalUrl, inSite, normalizeSite } = require('./url');
const { verifyPassage } = require('./passages');

/** Enveloppe des fournisseurs pour garder ce que chacun a rendu, page par page. */
function recordProviders(providers) {
  const seen = new Map();
  const wrapped = providers.map((provider) => ({
    ...provider,
    async search(request, context) {
      const answer = await provider.search(request, context);
      for (const hit of answer?.hits || []) {
        const key = `${provider.id} ${canonicalUrl(hit.url)}`;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(hit);
      }
      return answer;
    }
  }));
  return {
    providers: wrapped,
    /** Ce que ce moteur a rendu pour cette page (toutes les fois). */
    hitsFor: (providerId, url) => seen.get(`${providerId} ${canonicalUrl(url)}`) || []
  };
}

/**
 * Une recherche brute, pour comparer : un seul moteur, ses résultats tels quels
 * (ni dédoublonnage, ni filtre revérifié, ni fraîcheur).
 */
async function rawSearch(provider, request) {
  const answer = await provider.search({ sites: [], excludeSites: [], lang: null, country: null, freshness: null, limit: 8, ...request }, {});
  return {
    query: request.query,
    results: (answer?.hits || []).slice(0, request.limit || 8).map((hit, index) => ({
      id: `S${index + 1}`, title: hit.title, url: hit.url, canonicalUrl: canonicalUrl(hit.url) || hit.url,
      domain: (() => { try { return new URL(hit.url).hostname.replace(/^www\./, ''); } catch (_error) { return null; } })(),
      publishedAt: hit.publishedAt || null, snippet: hit.snippet, snippetFrom: provider.id
    }))
  };
}

function checkCase(found, expect = {}, { recorder, pageTexts }) {
  const results = found.results || [];
  const checks = {};
  if (recorder) {
    checks.noMixing = results.every((result) => recorder.hitsFor(result.snippetFrom, result.url)
      .some((hit) => hit.title === result.title && (hit.snippet || '') === (result.snippet || '')));
  }
  const canonicals = results.map((result) => result.canonicalUrl);
  checks.noDuplicates = new Set(canonicals).size === canonicals.length;
  const passages = results.flatMap((result) => (result.page?.status === 'read' ? result.page.passages.map((passage) => ({ url: result.url, passage })) : []));
  if (passages.length) checks.passagesVerified = passages.every(({ url, passage }) => pageTexts.has(url) && verifyPassage(pageTexts.get(url), passage));
  if (expect.expectedDomain) {
    const site = normalizeSite(expect.expectedDomain);
    const within = expect.within || 3;
    checks.expectedDomain = results.slice(0, within).some((result) => inSite(result.domain, site));
  }
  if (expect.recentFirst) {
    const dated = results.slice(0, expect.within || 3).filter((result) => result.publishedAt);
    checks.recentFirst = dated.length > 0 && results[0].publishedAt !== null
      && dated.every((result) => Date.parse(results[0].publishedAt) >= Date.parse(result.publishedAt));
  }
  if (expect.forbiddenDomains) {
    const forbidden = expect.forbiddenDomains.map(normalizeSite);
    checks.forbiddenDomains = results.every((result) => !forbidden.some((site) => inSite(result.domain, site)));
  }
  return checks;
}

/**
 * @param {object} options
 * @param {{ id: string, input: object, expect?: object }[]} options.cases
 * @param {Function} options.search       (input) => Promise<résultat de ws.search>
 * @param {object} [options.recorder]     recordProviders(…) : active le critère noMixing.
 * @param {Function} [options.readText]   async (url) => texte de la page, pour revérifier les passages.
 * @returns {Promise<{ cases: object[], summary: { cases: number, passed: number, checks: Record<string, { passed: number, total: number }> } }>}
 */
async function runEvaluation({ cases, search, recorder, readText }) {
  const out = [];
  const totals = {};
  for (const testCase of cases) {
    let found;
    try {
      found = await search(testCase.input);
    } catch (error) {
      out.push({ id: testCase.id, passed: false, error: error.code || 'error', checks: {} });
      continue;
    }
    const pageTexts = new Map();
    if (typeof readText === 'function') {
      for (const result of found.results || []) {
        if (result.page?.status !== 'read') continue;
        try {
          pageTexts.set(result.url, await readText(result.url));
        } catch (_error) {
          /* une page illisible au second passage fait échouer la vérification */
        }
      }
    }
    const checks = checkCase(found, testCase.expect, { recorder, pageTexts });
    for (const [name, ok] of Object.entries(checks)) {
      totals[name] = totals[name] || { passed: 0, total: 0 };
      totals[name].total += 1;
      if (ok) totals[name].passed += 1;
    }
    out.push({ id: testCase.id, passed: Object.values(checks).every(Boolean), checks, results: (found.results || []).map((result) => ({ id: result.id, domain: result.domain, url: result.url, publishedAt: result.publishedAt })) });
  }
  return { cases: out, summary: { cases: out.length, passed: out.filter((entry) => entry.passed).length, checks: totals } };
}

module.exports = { runEvaluation, recordProviders, rawSearch, checkCase };
