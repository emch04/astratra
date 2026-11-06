const { searchSerper } = require('../src');

const KEY = 'serper_do_not_leak_1234';

function fakeFetch(reply) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
    }
  };
}

describe('searchSerper', () => {
  test('searches within the sites asked, the key in the header; keeps https results with a title, filtered by the caller', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { organic: [
      { title: 'Le guide du jardinage', link: 'https://www.example.org/fr/guide/', snippet: 'Les bases expliquées.', date: '2 janv. 2025' },
      { title: 'Hostile', link: 'https://example.com/a', snippet: 'Une polémique.' },
      { title: 'Not a page', link: 'javascript:alert(1)', snippet: '' },
      { title: 'Plain http', link: 'http://www.example.org/fr/', snippet: '' },
      { title: '', link: 'https://www.example.org/fr/sans-titre/', snippet: '' },
      { title: 'Chapitre 4', link: 'https://docs.example.net/fr/livre/4', snippet: 'Arroser le matin.' }
    ] } });
    const results = await searchSerper(
      { query: 'arrosage', sites: ['example.org', 'docs.example.net'], hl: 'fr' },
      { key: KEY, fetch, accept: (_found, url) => url.hostname !== 'example.com' }
    );
    expect(calls[0].url).toBe('https://google.serper.dev/search');
    expect(calls[0].init.headers['X-API-KEY']).toBe(KEY);
    expect(calls[0].body).toEqual({ q: 'arrosage site:example.org OR site:docs.example.net', num: 8, hl: 'fr' });
    expect(results).toEqual([
      { title: 'Le guide du jardinage', url: 'https://www.example.org/fr/guide/', snippet: 'Les bases expliquées.', date: '2 janv. 2025' },
      { title: 'Chapitre 4', url: 'https://docs.example.net/fr/livre/4', snippet: 'Arroser le matin.', date: null }
    ]);
    expect(JSON.stringify(results)).not.toContain(KEY);
  });

  test('no key: nothing is asked; a failure carries a code, never the key', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: {} });
    await expect(searchSerper({ query: 'x' }, { key: '', fetch })).rejects.toMatchObject({ code: 'WEB_SEARCH_NO_KEY' });
    expect(calls).toHaveLength(0);
    const error = await searchSerper({ query: 'x' }, { key: KEY, fetch: fakeFetch({ status: 503, body: {} }).fetch }).catch((e) => e);
    expect(error).toMatchObject({ code: 'WEB_SEARCH_FAILED', message: 'Serper answered 503', status: 503 });
    expect(`${error.message}${error.stack}`).not.toContain(KEY);
  });

  test('at most num results; no sites, no scope', async () => {
    const organic = Array.from({ length: 5 }, (_, index) => ({ title: `R${index}`, link: `https://a.test/${index}` }));
    const { fetch, calls } = fakeFetch({ status: 200, body: { organic } });
    expect(await searchSerper({ query: 'x', num: 2 }, { key: KEY, fetch })).toHaveLength(2);
    expect(calls[0].body).toEqual({ q: 'x', num: 2 });
  });

  test('country and period go to Serper as gl and tbs; an unknown period asks nothing', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { organic: [] } });
    await searchSerper({ query: 'x', gl: 'FR', hl: 'fr', period: 'week' }, { key: KEY, fetch });
    expect(calls[0].body).toEqual({ q: 'x', num: 8, hl: 'fr', gl: 'fr', tbs: 'qdr:w' });
    await expect(searchSerper({ query: 'x', period: 'decade' }, { key: KEY, fetch })).rejects.toThrow('unknown period');
    expect(calls).toHaveLength(1);
  });

  test('a network failure has no status', async () => {
    const fetch = async () => { throw new Error('socket hang up'); };
    const error = await searchSerper({ query: 'x' }, { key: KEY, fetch }).catch((e) => e);
    expect(error.code).toBe('WEB_SEARCH_FAILED');
    expect(error.status).toBeUndefined();
  });
});
