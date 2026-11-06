const { createWebSearch, providerFailure, serperProvider, createMemoryCache } = require('../src');
const { fakeProvider, hit, fakeNetwork } = require('./helpers');

const NOW = Date.parse('2026-11-06T12:00:00Z');
const KEY = ['live', 'key', 'never', 'shown', '7'].join('_');
const PUBLIC = '93.184.216.34';
const base = { now: () => NOW, sleep: async () => {}, random: () => 0.5 };

const A = [hit('https://example.com/a', 'A', 'Extrait A.'), hit('https://example.org/b', 'B', 'Extrait B.')];
const B = [hit('https://example.org/b', 'B (2)', 'Autre extrait B.'), hit('https://example.net/c', 'C', 'Extrait C.', '2026-11-05T00:00:00.000Z')];

describe('fuse mode', () => {
  test('two engines answer together; one entry per page; ids, ranks and engines named', async () => {
    const one = fakeProvider('one', A);
    const two = fakeProvider('two', B);
    const ws = createWebSearch({ ...base, providers: [one, two] });
    const found = await ws.search('question');
    expect(found.results.map((result) => [result.id, result.domain, result.snippetFrom, result.foundBy])).toEqual([
      ['S1', 'example.org', 'two', ['one', 'two']],
      ['S2', 'example.com', 'one', ['one']],
      ['S3', 'example.net', 'two', ['two']]
    ]);
    expect(found.results[0]).toMatchObject({ title: 'B (2)', snippet: 'Autre extrait B.' });
    expect(found.report).toMatchObject({ mode: 'fuse', providersUsed: ['one', 'two'], costUsd: 0.002, costComplete: true });
    expect(found.searchedAt).toBe('2026-11-06T12:00:00.000Z');
  });

  test('a failing engine is replaced by the next one in the list', async () => {
    const down = fakeProvider('down', providerFailure('down', { status: 400 }));
    const one = fakeProvider('one', A);
    const spare = fakeProvider('spare', B);
    const found = await createWebSearch({ ...base, providers: [down, one, spare] }).search('q');
    expect(found.report.providersUsed).toEqual(['one', 'spare']);
    expect(found.report.providers.find((trace) => trace.provider === 'down')).toMatchObject({ ok: false, attempts: 1, error: { code: 'WEB_SEARCH_PROVIDER_FAILED', status: 400 } });
  });
});

describe('fallback mode', () => {
  test('one engine at a time; an empty answer gives the next its chance', async () => {
    const empty = fakeProvider('empty', []);
    const one = fakeProvider('one', A);
    const never = fakeProvider('never', B);
    const found = await createWebSearch({ ...base, mode: 'fallback', providers: [empty, one, never] }).search('q');
    expect(found.report.providersUsed).toEqual(['empty', 'one']);
    expect(found.results.map((result) => result.snippetFrom)).toEqual(['one', 'one']);
    expect(never.calls).toHaveLength(0);
  });

  test('a retryable failure is retried once, with a wait; a refusal is not', async () => {
    const waits = [];
    const flaky = fakeProvider('flaky', (_request, attempt) => (attempt === 1 ? providerFailure('flaky', { status: 503 }) : A));
    const ws = createWebSearch({ ...base, sleep: async (ms) => { waits.push(ms); }, mode: 'fallback', providers: [flaky] });
    const found = await ws.search('q');
    expect(flaky.calls).toHaveLength(2);
    expect(waits).toEqual([225]);
    expect(found.report.providers[0]).toMatchObject({ ok: true, attempts: 2 });
  });

  test('a quota answer puts the engine to rest; the next search skips it', async () => {
    let clock = NOW;
    const tired = fakeProvider('tired', providerFailure('tired', { status: 429 }));
    const one = fakeProvider('one', A);
    const ws = createWebSearch({ ...base, now: () => clock, cache: false, mode: 'fallback', cooldownMs: 60_000, providers: [tired, one] });
    await ws.search('q');
    await ws.search('q2');
    expect(tired.calls).toHaveLength(1);
    const report = (await ws.search('q3')).report;
    expect(report.providers[0]).toMatchObject({ provider: 'tired', skipped: 'resting' });
    clock += 61_000;
    await ws.search('q4');
    expect(tired.calls).toHaveLength(2);
  });
});

describe('quotas, cache, budget, report', () => {
  test('a quota per engine: past it, the engine is skipped', async () => {
    const one = fakeProvider('one', A);
    const two = fakeProvider('two', B);
    const ws = createWebSearch({ ...base, cache: false, mode: 'fallback', quotas: { one: { perDay: 2 } }, providers: [one, two] });
    for (const query of ['a', 'b', 'c']) await ws.search(query);
    expect(one.calls).toHaveLength(2);
    expect(two.calls).toHaveLength(1);
  });

  test('the same request comes from the cache, at no cost', async () => {
    const one = fakeProvider('one', A);
    const ws = createWebSearch({ ...base, mode: 'fallback', providers: [one] });
    await ws.search({ query: 'q', lang: 'fr' });
    const again = await ws.search({ query: 'q', lang: 'fr' });
    expect(one.calls).toHaveLength(1);
    expect(again.report.providers[0]).toMatchObject({ cached: true, costUsd: 0 });
    expect(again.report.costUsd).toBe(0);
    await ws.search({ query: 'q', lang: 'en' });
    expect(one.calls).toHaveLength(2);
  });

  test('a cache entry cannot be changed from outside', async () => {
    const cache = createMemoryCache();
    cache.set('k', { a: [1] }, 1000);
    cache.get('k').a.push(2);
    expect(cache.get('k')).toEqual({ a: [1] });
  });

  test('every engine down: one error with the report, never a key', async () => {
    const fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const ws = createWebSearch({ ...base, providers: [serperProvider({ key: KEY, fetch }), fakeProvider('two', new Error(`boom ${KEY}`))] });
    const error = await ws.search('q').catch((e) => e);
    expect(error).toMatchObject({ code: 'WEB_SEARCH_ALL_FAILED' });
    expect(error.report.providers.map((trace) => trace.ok)).toEqual([false, false]);
    expect(error.report.providers[1].error.message).toBe('two failed');
    expect(JSON.stringify(error.report) + error.message + error.stack).not.toContain(KEY);
  });

  test('unknown costs are said to be unknown; onReport gets every report', async () => {
    const reports = [];
    const free = fakeProvider('gateway', A, { costPerCallUsd: null });
    const found = await createWebSearch({ ...base, mode: 'fallback', providers: [free], onReport: (report) => reports.push(report) }).search('q');
    expect(found.report).toMatchObject({ costUsd: 0, costComplete: false });
    expect(reports).toHaveLength(1);
  });

  test('a rewrite changes what is asked, keeps the filters, and is reported', async () => {
    const one = fakeProvider('one', A);
    const found = await createWebSearch({ ...base, providers: [one], rewrite: async ({ query }) => `${query} guide` }).search({ query: 'tomates', sites: ['example.com'] });
    expect(one.calls[0].request).toMatchObject({ query: 'tomates guide', sites: ['example.com'] });
    expect(found.report).toMatchObject({ query: 'tomates', rewrittenQuery: 'tomates guide' });
    expect(found.results.every((result) => result.domain === 'example.com')).toBe(true);
  });

  test('the sites filter is checked again on arrival, whatever the engine did', async () => {
    const careless = fakeProvider('careless', [hit('https://other.example/x', 'X', 'x'), hit('https://example.com/a', 'A', 'a')]);
    const found = await createWebSearch({ ...base, providers: [careless] }).search({ query: 'q', sites: ['example.com'] });
    expect(found.results.map((result) => result.domain)).toEqual(['example.com']);
    expect(found.report.dropped.domain).toBe(1);
  });
});

describe('reading the top pages', () => {
  const article = (text, extra = '') => `<html><head>${extra}</head><body><article><p>${text}</p></article></body></html>`;
  const network = fakeNetwork({
    'example.com': { addresses: [PUBLIC], pages: {
      '/a': { body: article('Les tomates se plantent en mai, après les gelées.', '<meta property="article:published_time" content="2026-05-02">') },
      '/moved': { status: 301, headers: { location: 'https://elsewhere.example/landing' } },
      '/alias': { body: article('La même page que A, par une autre adresse.', '<link rel="canonical" href="https://example.com/a">') }
    } },
    'elsewhere.example': { addresses: [PUBLIC], pages: { '/landing': { body: article('Un tout autre site.') } } }
  });

  test('passages come from the page of THAT entry, with their position; the page date fills an unknown date', async () => {
    const one = fakeProvider('one', [hit('https://example.com/a', 'A', 'Planter les tomates.')]);
    const found = await createWebSearch({ ...base, ...network, providers: [one] }).search({ query: 'planter tomates mai', read: 1 });
    const [first] = found.results;
    expect(first.page.status).toBe('read');
    expect(first.page.passages[0]).toEqual({ text: 'Les tomates se plantent en mai, après les gelées.', start: 0, end: 49 });
    expect(first).toMatchObject({ publishedAt: '2026-05-02T00:00:00.000Z', dateSource: 'page' });
    expect(found.report.reads[0]).toMatchObject({ ok: true });
  });

  test('a page redirected to another site gives no passage to this entry', async () => {
    const one = fakeProvider('one', [hit('https://example.com/moved', 'Moved', 'Ancien extrait.')]);
    const found = await createWebSearch({ ...base, ...network, providers: [one] }).search({ query: 'site', read: 1 });
    expect(found.results[0].page).toEqual({ status: 'other_site', finalUrl: 'https://elsewhere.example/landing' });
    expect(JSON.stringify(found.results)).not.toContain('tout autre site');
    expect(found.report.dropped.otherSite).toBe(1);
  });

  test('two addresses that turn out to be the same page are one entry', async () => {
    const one = fakeProvider('one', [hit('https://example.com/a', 'A', 'a'), hit('https://example.com/alias', 'Alias', 'b')]);
    const found = await createWebSearch({ ...base, ...network, providers: [one] }).search({ query: 'tomates', read: 2 });
    expect(found.results).toHaveLength(1);
    expect(found.report.dropped.duplicate).toBe(1);
  });

  test('ws.read checks quotes; a blocked address throws before any connection', async () => {
    const ws = createWebSearch({ ...base, ...network, providers: [fakeProvider('one', A)] });
    const page = await ws.read('https://example.com/a', { quotes: ['plantent en mai', 'en juin'] });
    expect(page.quotes).toEqual([
      { quote: 'plantent en mai', found: true, exact: true, start: 15, end: 30, text: 'plantent en mai' },
      { quote: 'en juin', found: false }
    ]);
    expect(page).toMatchObject({ sameSite: true, domain: 'example.com', canonicalUrl: 'https://example.com/a' });
    await expect(ws.read('https://10.0.0.1/')).rejects.toMatchObject({ code: 'WEB_READ_BLOCKED_ADDRESS' });
  });
});

describe('quota store', () => {
  test('a failing quota store closes only the engine that has quotas, without leaking its error', async () => {
    const quotaStore = { get: async () => { throw new Error('redis://user:secret@db.example:6379 refused'); }, incr: async () => { throw new Error('down'); } };
    const metered = fakeProvider('metered', A);
    const free = fakeProvider('free', B);
    const found = await createWebSearch({ ...base, quotaStore, quotas: { metered: { perDay: 10 } }, providers: [metered, free] }).search('q');
    expect(metered.calls).toHaveLength(0);
    expect(found.report.providers.find((trace) => trace.provider === 'metered')).toMatchObject({ skipped: 'quota_store_failed', ok: false });
    expect(found.report.providersUsed).toEqual(['free']);
    expect(JSON.stringify(found.report)).not.toContain('secret');
  });

  test('two searches at the limit at the same time: only one goes through', async () => {
    let count = 0;
    const quotaStore = { get: async () => count, incr: async () => { count += 1; return count; } };
    const metered = fakeProvider('metered', A);
    const ws = createWebSearch({ ...base, cache: false, mode: 'fallback', quotaStore, quotas: { metered: { perDay: 1 } }, providers: [metered, fakeProvider('spare', B)] });
    await Promise.all([ws.search('a'), ws.search('b')]);
    expect(metered.calls).toHaveLength(1);
  });
});

describe('a declared canonical cannot hide another result', () => {
  test('a read page that claims to be an unread result does not remove it', async () => {
    const network = fakeNetwork({ 'example.com': { addresses: [PUBLIC], pages: {
      '/claims': { body: '<html><head><link rel="canonical" href="https://example.com/other"></head><body><article><p>Je prétends être une autre page.</p></article></body></html>' }
    } } });
    const one = fakeProvider('one', [hit('https://example.com/claims', 'Claims', 'c'), hit('https://example.com/other', 'Other', 'o')]);
    const found = await createWebSearch({ ...base, ...network, providers: [one] }).search({ query: 'page', read: 1 });
    expect(found.results.map((result) => result.title)).toEqual(['Claims', 'Other']);
  });
});
