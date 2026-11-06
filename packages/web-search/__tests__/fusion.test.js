const { fuseRankings, rankEntries, normalizeRequest } = require('../src');
const { hit } = require('./helpers');

const NOW = Date.parse('2026-11-06T12:00:00Z');
const request = (input) => normalizeRequest(input, { now: NOW });

describe('rank fusion without content fusion', () => {
  const serper = [
    hit('https://www.example.org/guide?utm_source=a', 'Guide (A)', 'Extrait de A sur le guide.'),
    hit('https://example.net/b', 'Page B', 'Extrait de B.'),
    hit('https://example.com/c', 'Page C', 'Extrait de C.')
  ];
  const brave = [
    hit('https://example.com/c', 'Page C chez Brave', 'Brave: extrait de C.', '2026-11-01T00:00:00.000Z'),
    hit('https://example.org/guide', 'Guide chez Brave', 'Brave: extrait du guide.'),
    hit('https://example.info/d', 'Page D', 'Extrait de D.')
  ];

  test('a page found by both engines is one entry, its text from ONE engine only', () => {
    const entries = fuseRankings([{ provider: 'serper', hits: serper }, { provider: 'brave', hits: brave }]);
    expect(entries.map((entry) => entry.canonicalUrl)).toEqual([
      'https://example.org/guide', 'https://example.com/c', 'https://example.net/b', 'https://example.info/d'
    ]);
    const guide = entries[0];
    expect(guide.foundBy).toEqual(['serper', 'brave']);
    expect(guide.ranks).toEqual({ serper: 1, brave: 2 });
    /* Mieux classée par Serper : titre, adresse et extrait de Serper, en entier. */
    expect(guide).toMatchObject({ title: 'Guide (A)', snippet: 'Extrait de A sur le guide.', snippetFrom: 'serper', url: 'https://www.example.org/guide?utm_source=a' });
    const c = entries[1];
    expect(c).toMatchObject({ title: 'Page C chez Brave', snippet: 'Brave: extrait de C.', snippetFrom: 'brave', publishedAt: '2026-11-01T00:00:00.000Z', dateSource: 'brave' });
    for (const entry of entries) {
      const own = [...serper, ...brave].filter((h) => h.title === entry.title);
      expect(own).toHaveLength(1);
      expect(own[0].snippet).toBe(entry.snippet);
    }
  });

  test('RRF: 1/(60+rank) in each list', () => {
    const [guide] = fuseRankings([{ provider: 'serper', hits: serper }, { provider: 'brave', hits: brave }]);
    expect(guide.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
  });

  test('a date given by another engine for THE SAME page is kept, and its origin named', () => {
    const entries = fuseRankings([
      { provider: 'serper', hits: [hit('https://example.com/c', 'C', 'S.')] },
      { provider: 'exa', hits: [hit('https://example.com/c', 'C exa', 'E.', '2026-10-01T00:00:00.000Z')] }
    ]);
    expect(entries[0]).toMatchObject({ snippetFrom: 'serper', snippet: 'S.', publishedAt: '2026-10-01T00:00:00.000Z', dateSource: 'exa' });
  });

  test('a duplicate inside one list counts once; non-https is dropped', () => {
    const entries = fuseRankings([{ provider: 'serper', hits: [hit('https://example.com/a', 'A', '1'), hit('https://example.com/a#x', 'A bis', '2'), hit('http://example.com/z', 'Z', '')] }]);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('A');
  });
});

describe('final ranking', () => {
  const entries = fuseRankings([{ provider: 'p', hits: [
    hit('https://old.example.com/1', 'Old', 'old', '2025-01-01T00:00:00.000Z'),
    hit('https://example.org/1', 'Undated', 'none'),
    hit('https://news.example.net/1', 'Fresh', 'fresh', '2026-11-06T08:00:00.000Z'),
    hit('https://news.example.net/2', 'Fresh 2', 'fresh', '2026-11-05T08:00:00.000Z'),
    hit('https://news.example.net/3', 'Fresh 3', 'fresh', '2026-11-04T08:00:00.000Z'),
    hit('https://blocked.example/1', 'Blocked', 'x')
  ] }]);

  test('recent first when the question wants it, without filtering anything', () => {
    const { entries: ranked } = rankEntries(entries, request({ query: "ce qui s'est passé aujourd'hui" }), { now: NOW, blockDomains: ['blocked.example'] });
    expect(ranked[0].title).toBe('Fresh');
    expect(ranked.map((entry) => entry.title)).toContain('Old');
  });

  test('a freshness filter drops known old pages, keeps undated ones; at most 2 per site', () => {
    const { entries: ranked, dropped } = rankEntries(entries, request({ query: 'x', freshness: 'week' }), { now: NOW, blockDomains: ['blocked.example'] });
    expect(ranked.map((entry) => entry.title)).toEqual(['Fresh', 'Fresh 2', 'Undated']);
    expect(dropped).toEqual({ domain: 1, freshness: 1, perDomain: 1 });
  });

  test('sites, exclusions, preferred and demoted domains', () => {
    expect(rankEntries(entries, request({ query: 'x', sites: ['example.net'] }), { now: NOW }).entries.every((entry) => entry.domain === 'news.example.net')).toBe(true);
    expect(rankEntries(entries, request({ query: 'x', excludeSites: ['example.net'] }), { now: NOW }).entries.some((entry) => entry.domain.endsWith('example.net'))).toBe(false);
    const preferred = rankEntries(entries, request({ query: 'x', freshness: 'any' }), { now: NOW, preferDomains: ['blocked.example'], demoteDomains: ['old.example.com'] }).entries;
    expect(preferred[0].title).toBe('Blocked');
    expect(preferred[preferred.length - 1].title).toBe('Old');
    expect(rankEntries(entries, request({ query: 'x' }), { now: NOW, domainScore: (domain) => (domain === 'example.org' ? 0 : 1) }).entries.some((entry) => entry.domain === 'example.org')).toBe(false);
  });
});
