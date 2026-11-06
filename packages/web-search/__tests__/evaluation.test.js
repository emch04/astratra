/*
 * La batterie d'évaluation, sur un corpus fixe : deux moteurs simulés qui ont
 * les défauts des vrais (doublons sous deux adresses, filtre ignoré, page
 * ancienne en tête, bon site loin dans un seul des deux classements), et des
 * pages simulées pour la lecture. On compare :
 *   - la recherche brute d'un seul moteur (ce que fait une IA qui appelle Serper seule) ;
 *   - une fusion naïve qui colle les extraits des deux moteurs pour un même titre ;
 *   - l'outil.
 */
const { createWebSearch, runEvaluation, recordProviders, rawSearch, canonicalUrl } = require('../src');
const { hit, fakeNetwork } = require('./helpers');

const NOW = Date.parse('2026-11-06T12:00:00Z');

const ENGINE_A = {
  'documentation officielle du format': [
    hit('https://blog.example.net/format', 'Mon avis sur le format', 'Un billet.'),
    hit('https://forum.example.info/t/1', 'Question sur le format', 'Une discussion.'),
    hit('https://copie.example.biz/format', 'Le format expliqué', 'Une copie.'),
    hit('https://docs.example.org/format', 'Format : référence', 'La référence du format, par ses auteurs.')
  ],
  'tutoriel jardinage tomates': [
    hit('https://www.example.com/tomates?utm_source=moteur', 'Tomates : le guide', 'Planter, arroser, récolter.'),
    hit('https://example.com/tomates', 'Tomates : le guide (copie)', 'Le même guide.'),
    hit('https://example.com/tomates/', 'Tomates', 'Encore le même.'),
    hit('https://example.net/semis', 'Semis', 'Les semis.')
  ],
  'dernière version du logiciel': [
    hit('https://example.org/notes/1.0', 'Version 1.0', 'Notes de la version 1.0.', '2024-03-01T00:00:00.000Z'),
    hit('https://example.org/notes/2.0', 'Version 2.0', 'Notes de la version 2.0.', '2025-06-01T00:00:00.000Z'),
    hit('https://example.org/notes/3.0', 'Version 3.0', 'Notes de la version 3.0.', '2026-11-02T00:00:00.000Z')
  ],
  'avis produit': [
    hit('https://spam.example.biz/avis', 'Avis 5 étoiles', 'Achetez maintenant.'),
    hit('https://example.com/avis', 'Avis détaillé', 'Un test complet.')
  ],
  'planter les tomates en mai': [
    hit('https://example.com/mai', 'Planter en mai', 'Quand planter.')
  ],
  'définition du terme': [
    hit('https://example.com/terme', 'Le terme', 'Extrait du moteur A.')
  ]
};
const ENGINE_B = {
  'documentation officielle du format': [
    hit('https://docs.example.org/format', 'Référence du format', 'Le texte de référence.'),
    hit('https://blog.example.net/format', 'Mon avis', 'Un billet.')
  ],
  'définition du terme': [
    hit('https://example.com/terme', 'Le terme', 'Extrait du moteur B, différent.'),
    hit('https://example.org/glossaire', 'Glossaire', 'Un glossaire.')
  ]
};

/* Un moteur simulé qui ignore les filtres de sites, comme un moteur qui les comprend mal. */
const engine = (id, table) => ({ id, costPerCallUsd: 0.001, search: async (request) => ({ hits: table[request.query] || [] }) });

const network = fakeNetwork({ 'example.com': { addresses: ['93.184.216.34'], pages: {
  '/mai': { body: '<article><p>Plantez les tomates en mai, après les dernières gelées.</p><p>Arrosez au pied.</p></article>' }
} } });

const CASES = [
  { id: 'right-source', input: { query: 'documentation officielle du format' }, expect: { expectedDomain: 'docs.example.org', within: 3 } },
  { id: 'duplicates', input: { query: 'tutoriel jardinage tomates' }, expect: {} },
  { id: 'freshness', input: { query: 'dernière version du logiciel' }, expect: { recentFirst: true, within: 3 } },
  { id: 'excluded-site', input: { query: 'avis produit', excludeSites: ['spam.example.biz'] }, expect: { forbiddenDomains: ['spam.example.biz'] } },
  { id: 'verbatim', input: { query: 'planter les tomates en mai', read: 1 }, expect: {} },
  { id: 'no-mixing', input: { query: 'définition du terme' }, expect: {} }
];

/** Une fusion naïve : un titre, et les extraits des deux moteurs collés ensemble. */
async function naiveMerge(input) {
  const a = (await engine('a', ENGINE_A).search({ query: input.query })).hits;
  const b = (await engine('b', ENGINE_B).search({ query: input.query })).hits;
  const byTitle = new Map();
  for (const result of [...a, ...b]) {
    const known = byTitle.get(result.title);
    if (known) known.snippet = `${known.snippet} ${result.snippet}`;
    else byTitle.set(result.title, { ...result, snippetFrom: 'a', canonicalUrl: canonicalUrl(result.url), domain: new URL(result.url).hostname });
  }
  return { results: [...byTitle.values()] };
}

describe('evaluation battery', () => {
  test('the tool passes every check; raw search and naive merging do not', async () => {
    const recorder = recordProviders([engine('a', ENGINE_A), engine('b', ENGINE_B)]);
    const ws = createWebSearch({ providers: recorder.providers, ...network, now: () => NOW, sleep: async () => {} });
    const tool = await runEvaluation({ cases: CASES, search: (input) => ws.search(input), recorder, readText: async (url) => (await ws.read(url)).text });

    const rawRecorder = recordProviders([engine('a', ENGINE_A)]);
    const raw = await runEvaluation({ cases: CASES, search: (input) => rawSearch(rawRecorder.providers[0], input), recorder: rawRecorder });

    const naiveRecorder = recordProviders([engine('a', ENGINE_A), engine('b', ENGINE_B)]);
    for (const testCase of CASES) await naiveRecorder.providers[0].search({ query: testCase.input.query });
    const naive = await runEvaluation({ cases: CASES.filter((testCase) => testCase.id === 'no-mixing'), search: naiveMerge, recorder: naiveRecorder });

    expect(tool.cases.filter((entry) => !entry.passed)).toEqual([]);
    expect(tool.summary).toMatchObject({ cases: 6, passed: 6 });
    expect(tool.summary.checks).toMatchObject({
      noMixing: { passed: 6, total: 6 }, noDuplicates: { passed: 6, total: 6 }, passagesVerified: { passed: 1, total: 1 },
      expectedDomain: { passed: 1, total: 1 }, recentFirst: { passed: 1, total: 1 }, forbiddenDomains: { passed: 1, total: 1 }
    });

    const rawFailed = raw.cases.filter((entry) => !entry.passed).map((entry) => entry.id).sort();
    expect(rawFailed).toEqual(['duplicates', 'excluded-site', 'freshness', 'right-source']);
    expect(naive.cases[0].checks.noMixing).toBe(false);
  });

  test('a passage that is not on its page fails the check', async () => {
    const fake = { results: [{ id: 'S1', url: 'https://example.com/mai', canonicalUrl: 'https://example.com/mai', domain: 'example.com', title: 'T', snippet: '', snippetFrom: 'a', page: { status: 'read', passages: [{ text: 'Plantez en juin', start: 0, end: 15 }] } }] };
    const report = await runEvaluation({ cases: [{ id: 'x', input: {} }], search: async () => fake, readText: async () => 'Plantez les tomates en mai.' });
    expect(report.cases[0].checks.passagesVerified).toBe(false);
  });
});
