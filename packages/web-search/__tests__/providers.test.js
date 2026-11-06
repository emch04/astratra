const { serperProvider, braveProvider, tavilyProvider, exaProvider, gatewayProvider, normalizeRequest } = require('../src');

const NOW = Date.parse('2026-11-06T12:00:00Z');
/* Assemblée à l'exécution : un scanner de secrets n'y voit pas une vraie clé. */
const KEY = ['test', 'key', 'do', 'not', 'leak', '42'].join('_');
const request = (input) => normalizeRequest(input, { now: NOW });

function fakeFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (reply instanceof Error) throw reply;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  return { fetch, calls };
}

async function failureOf(promise) {
  const error = await promise.catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain(KEY);
  return error;
}

describe('Serper (through searchSerper of @astratra/ai)', () => {
  test('filters, country, language and period; dates parsed', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { organic: [{ title: 'A', link: 'https://example.com/a', snippet: 'a', date: '2 days ago' }] } });
    const found = await serperProvider({ key: KEY, fetch }).search(request({ query: 'q', sites: ['example.com'], excludeSites: ['spam.example'], lang: 'fr', country: 'FR', freshness: 'month' }), { now: NOW });
    expect(calls[0].init.headers['X-API-KEY']).toBe(KEY);
    expect(calls[0].body).toEqual({ q: 'q -site:spam.example site:example.com', num: 10, hl: 'fr', gl: 'fr', tbs: 'qdr:m' });
    expect(found.hits).toEqual([{ title: 'A', url: 'https://example.com/a', snippet: 'a', publishedAt: '2026-11-04T12:00:00.000Z' }]);
  });

  test('a 429 is a quota, a 503 can be retried, the key never shows', async () => {
    const quota = await failureOf(serperProvider({ key: KEY, fetch: fakeFetch({ status: 429, body: {} }).fetch }).search(request('q')));
    expect(quota).toMatchObject({ code: 'WEB_SEARCH_PROVIDER_FAILED', provider: 'serper', status: 429, quota: true });
    const outage = await failureOf(serperProvider({ key: KEY, fetch: fakeFetch({ status: 503, body: {} }).fetch }).search(request('q')));
    expect(outage).toMatchObject({ status: 503, retryable: true, quota: false });
    const nokey = await failureOf(serperProvider({ key: () => '' , fetch: fakeFetch({ status: 200, body: {} }).fetch }).search(request('q')));
    expect(nokey.message).toBe('serper has no key');
  });
});

describe('Brave Search', () => {
  test('GET with the subscription token, HTML removed from descriptions, extra snippets of the same page', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { web: { results: [{
      title: 'Le <strong>guide</strong>', url: 'https://example.org/g', description: 'Un <strong>bon</strong> guide &amp; plus',
      extra_snippets: ['Second <b>extrait</b>.'], page_age: '2026-11-01T10:00:00'
    }] } } });
    const found = await braveProvider({ key: KEY, fetch }).search(request({ query: 'guide', sites: ['example.org'], country: 'fr', lang: 'fr', freshness: 'week' }), { now: NOW });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'guide site:example.org', count: '10', safesearch: 'moderate', extra_snippets: 'true', country: 'FR', search_lang: 'fr', freshness: 'pw' });
    expect(calls[0].init.headers['X-Subscription-Token']).toBe(KEY);
    expect(calls[0].url).not.toContain(KEY);
    expect(found.hits).toEqual([{ title: 'Le guide', url: 'https://example.org/g', snippet: 'Un bon guide & plus', extraSnippets: ['Second extrait.'], publishedAt: '2026-11-01T10:00:00.000Z' }]);
  });

  test('a short cache by default (storage rights)', () => {
    expect(braveProvider({ key: KEY }).cacheTtlMs).toBe(60_000);
  });

  test('a network failure is retryable, without the key', async () => {
    const error = await failureOf(braveProvider({ key: KEY, fetch: fakeFetch(new Error(`ECONNRESET ${KEY}`)).fetch }).search(request('q')));
    expect(error).toMatchObject({ retryable: true, quota: false });
  });
});

describe('Tavily', () => {
  test('basic depth, native domain filters, time range, country name; never a generated answer', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { results: [{ title: 'T', url: 'https://example.net/t', content: 'extrait', score: 0.9, published_date: 'Sep 2, 2026' }] } });
    const found = await tavilyProvider({ key: KEY, fetch }).search(request({ query: 'q', sites: ['example.net'], excludeSites: ['spam.example'], freshness: 'day', country: 'fr' }), { now: NOW });
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body).toEqual({
      query: 'q', search_depth: 'basic', topic: 'general', max_results: 10, include_answer: false, include_raw_content: false,
      include_published_date: true, include_domains: ['example.net'], exclude_domains: ['spam.example'], time_range: 'day', country: 'france'
    });
    expect(found.hits).toEqual([{ title: 'T', url: 'https://example.net/t', snippet: 'extrait', publishedAt: '2026-09-02T00:00:00.000Z' }]);
  });

  test('402: out of credits is a quota, not retried', async () => {
    const error = await failureOf(tavilyProvider({ key: KEY, fetch: fakeFetch({ status: 402, body: {} }).fetch }).search(request('q')));
    expect(error).toMatchObject({ status: 402, quota: true, retryable: false });
  });
});

describe('Exa', () => {
  test('highlights from the page, published date window, the cost Exa reports', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { results: [{ title: 'E', url: 'https://example.info/e', publishedDate: '2026-11-02T00:00:00.000Z', highlights: ['Premier passage.', 'Second passage.'] }], costDollars: { total: 0.006 } } });
    const found = await exaProvider({ key: KEY, fetch }).search(request({ query: 'q', excludeSites: ['spam.example'], freshness: 'week', country: 'fr' }), { now: NOW });
    expect(calls[0].init.headers['x-api-key']).toBe(KEY);
    expect(calls[0].body).toEqual({
      query: 'q', type: 'auto', numResults: 10, contents: { highlights: { maxCharacters: 400 } },
      excludeDomains: ['spam.example'], startPublishedDate: '2026-10-30T12:00:00.000Z', userLocation: 'FR'
    });
    expect(found).toEqual({ hits: [{ title: 'E', url: 'https://example.info/e', snippet: 'Premier passage.', extraSnippets: ['Second passage.'], publishedAt: '2026-11-02T00:00:00.000Z' }], costUsd: 0.006 });
  });
});

describe('a gateway of your own', () => {
  test('the gateway client is injected; sites go as operators; French period names', async () => {
    const asked = [];
    const provider = gatewayProvider({ search: async (demande) => {
      asked.push(demande);
      return { fournisseur: 'serper', resultats: [{ position: 1, titre: 'G', url: 'https://example.com/g', extrait: 'ex', date: '2 sept. 2026' }] };
    } });
    const found = await provider.search(request({ query: 'q', sites: ['example.com'], freshness: 'year', lang: 'fr', country: 'fr' }), { now: NOW });
    expect(asked[0]).toEqual({ requete: 'q site:example.com', nombre: 10, langue: 'fr', pays: 'fr', periode: 'an' });
    expect(found).toEqual({ engine: 'serper', hits: [{ title: 'G', url: 'https://example.com/g', snippet: 'ex', publishedAt: '2026-09-02T00:00:00.000Z' }] });
    expect(provider.costPerCallUsd).toBeNull();
  });

  test('an unavailable gateway lets the next provider try', async () => {
    class PasserelleIndisponible extends Error {
      constructor() { super('Passerelle indisponible (503)'); this.name = 'PasserelleIndisponible'; this.statut = 503; }
    }
    const error = await gatewayProvider({ search: async () => { throw new PasserelleIndisponible(); } }).search(request('q')).catch((e) => e);
    expect(error).toMatchObject({ code: 'WEB_SEARCH_PROVIDER_FAILED', provider: 'gateway', status: 503, retryable: false });
    expect(() => gatewayProvider({})).toThrow('options.search');
  });
});
