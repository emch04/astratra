/* global fetch, AbortController */
/* Le service astratra-web-browser avec un moteur simulé, et son client sur un vrai port (contrat client ↔ service). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBrowserService } = require('../src/browser/service');
const { createBrowserClient, createLocalBrowser } = require('../src/browser/client');

const TOKEN = 'jeton-de-test-assez-long-0123456789';
const okIsolation = async () => ({ ok: true, checkedAt: 'x', probes: [] });

function tokenFile(content = TOKEN) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'astratra-browser-token-'));
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, `${content}\n`, { mode: 0o600 });
  return file;
}

function fakeEngine(overrides = {}) {
  const calls = [];
  return {
    calls,
    started: false,
    closed: false,
    async start() { this.started = true; },
    async close() { this.closed = true; },
    async open(request, { signal } = {}) {
      calls.push({ kind: 'open', request, signal });
      if (overrides.open) return overrides.open(request, { signal });
      return { status: 'ok', url: request.url, finalUrl: request.url, title: 'T', text: 'texte', links: [] };
    },
    async siteSearch(request) {
      calls.push({ kind: 'site-search', request });
      if (overrides.siteSearch) return overrides.siteSearch(request);
      return { status: 'ok', url: request.url, searchUrl: `${request.url}?q=${request.query}`, via: 'form', text: 'résultats', links: [] };
    },
    async health() { return { ok: true, chromium: '156.0', sandbox: true, active: 0, queued: 0, max: 2 }; }
  };
}

async function startService(engine, extra = {}) {
  const file = extra.tokenFile || tokenFile();
  const service = createBrowserService({ engine, tokenFile: file, port: 0, checkIsolation: okIsolation, ...extra });
  const started = await service.start();
  const baseUrl = `http://127.0.0.1:${started.port}`;
  return { service, baseUrl, file };
}

const post = (baseUrl, route, body, headers = {}) => fetch(`${baseUrl}${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

describe('service astratra-web-browser', () => {
  let engine;
  let ctx;
  beforeEach(async () => {
    engine = fakeEngine();
    ctx = await startService(engine);
  });
  afterEach(async () => {
    await ctx.service.close();
  });

  test('ouvre une page ; démarre le moteur ; contrôle d\'isolement fait', async () => {
    expect(engine.started).toBe(true);
    const response = await post(ctx.baseUrl, '/v1/open', { url: 'https://a.example/', screenshot: true, allowDomains: ['a.example'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', text: 'texte' });
    expect(engine.calls[0].request).toEqual({ url: 'https://a.example/', screenshot: true, allowDomains: ['a.example'] });
    expect(ctx.service.isolation()).toMatchObject({ ok: true });
  });

  test('recherche interne', async () => {
    const response = await post(ctx.baseUrl, '/v1/site-search', { url: 'https://a.example/', query: 'pomme' });
    expect(await response.json()).toMatchObject({ status: 'ok', via: 'form' });
  });

  test('sans jeton, mauvais jeton, jeton de même longueur : 401', async () => {
    expect((await post(ctx.baseUrl, '/v1/open', { url: 'https://a.example/' }, { authorization: '' })).status).toBe(401);
    expect((await post(ctx.baseUrl, '/v1/open', { url: 'https://a.example/' }, { authorization: 'Bearer faux' })).status).toBe(401);
    expect((await post(ctx.baseUrl, '/v1/open', { url: 'https://a.example/' }, { authorization: `Bearer ${TOKEN.replace(/.$/, 'X')}` })).status).toBe(401);
    expect(engine.calls).toEqual([]);
  });

  test('le jeton est relu à chaque requête', async () => {
    fs.writeFileSync(ctx.file, 'nouveau-jeton-assez-long-pour-servir');
    expect((await post(ctx.baseUrl, '/v1/open', { url: 'https://a.example/' })).status).toBe(401);
    expect((await post(ctx.baseUrl, '/v1/open', { url: 'https://a.example/' }, { authorization: 'Bearer nouveau-jeton-assez-long-pour-servir' })).status).toBe(200);
    fs.writeFileSync(ctx.file, 'court');
    const short = await post(ctx.baseUrl, '/v1/open', { url: 'https://a.example/' }, { authorization: 'Bearer court' });
    expect(short.status).toBe(503);
    expect((await short.json()).error.code).toBe('token_unavailable');
  });

  test.each([
    [{}, 'url'],
    [{ url: 'https://a.example/', inconnu: 1 }, 'unknown field'],
    [{ url: 'https://a.example/', screenshot: 'oui' }, 'screenshot'],
    [{ url: 'https://a.example/', waitFor: 'x'.repeat(201) }, 'waitFor'],
    [{ url: 'https://a.example/', lang: 'français' }, 'lang'],
    [{ url: 'https://a.example/', allowDomains: 'a.example' }, 'allowDomains'],
    [{ url: 'x'.repeat(2049) }, 'url'],
    [[1, 2], 'JSON object']
  ])('entrée refusée : %j', async (body, message) => {
    const response = await post(ctx.baseUrl, '/v1/open', body);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain(message);
    expect(engine.calls).toEqual([]);
  });

  test('recherche interne sans requête : 400', async () => {
    expect((await post(ctx.baseUrl, '/v1/site-search', { url: 'https://a.example/' })).status).toBe(400);
  });

  test('corps trop gros, mauvais type, JSON illisible', async () => {
    expect((await post(ctx.baseUrl, '/v1/open', JSON.stringify({ url: 'https://a.example/', lang: 'x'.repeat(20_000) }))).status).toBe(413);
    expect((await post(ctx.baseUrl, '/v1/open', '{"url":', {})).status).toBe(400);
    expect((await post(ctx.baseUrl, '/v1/open', 'url=x', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
  });

  test('routes inconnues et mauvaises méthodes', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${ctx.baseUrl}/v1/act`, { method: 'POST', headers: auth })).status).toBe(404);
    expect((await fetch(`${ctx.baseUrl}/v1/open`, { headers: auth })).status).toBe(405);
  });

  test('santé : version, Chromium, isolement', async () => {
    const response = await fetch(`${ctx.baseUrl}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, chromium: '156.0', sandbox: true, isolation: { ok: true }, unsafeNoFirewall: false });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await fetch(`${ctx.baseUrl}/health`)).status).toBe(401);
  });
});

describe('démarrage', () => {
  test('refuse d\'écouter ailleurs que sur la boucle locale', () => {
    expect(() => createBrowserService({ engine: fakeEngine(), tokenFile: '/x', host: '0.0.0.0' })).toThrow(/127\.0\.0\.1/);
    expect(() => createBrowserService({ engine: fakeEngine() })).toThrow(/tokenFile/);
  });

  test('isolement en échec : refuse de démarrer, ferme le moteur', async () => {
    const engine = fakeEngine();
    const service = createBrowserService({
      engine, tokenFile: tokenFile(), port: 0,
      checkIsolation: async () => ({ ok: false, probes: [{ name: 'loopback', outcome: 'reached' }] })
    });
    await expect(service.start()).rejects.toMatchObject({ code: 'isolation_failed' });
    expect(engine.closed).toBe(true);
    expect(service.address()).toBeNull();
  });

  test('isolement en échec avec unsafeNoFirewall : démarre, la santé le dit', async () => {
    const engine = fakeEngine();
    const { service, baseUrl } = await startService(engine, { unsafeNoFirewall: true, checkIsolation: async () => ({ ok: false, probes: [] }) });
    try {
      const body = await (await fetch(`${baseUrl}/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
      expect(body).toMatchObject({ isolation: { ok: false }, unsafeNoFirewall: true });
    } finally {
      await service.close();
    }
  });

  test('le vrai contrôle d\'isolement, sur cette machine sans pare-feu : refus de démarrer', async () => {
    const engine = fakeEngine();
    const service = createBrowserService({ engine, tokenFile: tokenFile(), port: 0 });
    await expect(service.start()).rejects.toMatchObject({ code: 'isolation_failed' });
  });
});

describe('client ↔ service', () => {
  let engine;
  let ctx;
  afterEach(async () => {
    await ctx?.service.close();
  });

  test('contrat : open, siteSearch, health ; le jeton vient d\'un fichier', async () => {
    engine = fakeEngine();
    ctx = await startService(engine);
    const client = createBrowserClient({ baseUrl: ctx.baseUrl, tokenFile: ctx.file });
    expect(await client.open({ url: 'https://a.example/' })).toMatchObject({ ok: true, result: { status: 'ok', text: 'texte' } });
    expect(await client.siteSearch({ url: 'https://a.example/', query: 'q' })).toMatchObject({ ok: true, result: { via: 'form' } });
    expect(await client.health()).toMatchObject({ ok: true, result: { ok: true } });
  });

  test('un statut de page (robots, bloqué) reste une réponse', async () => {
    engine = fakeEngine({ open: async () => ({ status: 'robots_disallowed', url: 'https://a.example/x' }) });
    ctx = await startService(engine);
    const client = createBrowserClient({ baseUrl: ctx.baseUrl, token: TOKEN });
    expect(await client.open({ url: 'https://a.example/x' })).toEqual({ ok: true, result: { status: 'robots_disallowed', url: 'https://a.example/x' } });
  });

  test('service occupé : busy, nouvel essai, puis refus', async () => {
    let calls = 0;
    engine = fakeEngine({ open: async () => { calls += 1; return { status: 'busy' }; } });
    ctx = await startService(engine);
    const client = createBrowserClient({ baseUrl: ctx.baseUrl, token: TOKEN, sleep: async () => {} });
    expect(await client.open({ url: 'https://a.example/' })).toMatchObject({ ok: false, code: 'busy', retryable: true, status: 503 });
    expect(calls).toBe(2);
  });

  test('entrée refusée et mauvais jeton : pas de nouvel essai', async () => {
    engine = fakeEngine();
    ctx = await startService(engine);
    const client = createBrowserClient({ baseUrl: ctx.baseUrl, token: 'mauvais-jeton-de-test-0123456789', sleep: async () => {} });
    expect(await client.open({ url: 'https://a.example/' })).toMatchObject({ ok: false, code: 'unauthorized', retryable: false });
    const good = createBrowserClient({ baseUrl: ctx.baseUrl, token: TOKEN });
    expect(await good.open({ url: 'pas une adresse', extra: 1 })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('client sans service', () => {
  const response = (status, body) => ({ status, json: async () => body });

  test('service arrêté : network_error, puis le disjoncteur s\'ouvre', async () => {
    let calls = 0;
    const client = createBrowserClient({
      fetch: async () => { calls += 1; throw new TypeError('fetch failed'); },
      token: TOKEN,
      sleep: async () => {},
      breaker: { failureThreshold: 2, recoveryMs: 60_000 }
    });
    expect(await client.open({ url: 'https://a.example/' })).toMatchObject({ ok: false, code: 'network_error' });
    expect(await client.open({ url: 'https://a.example/' })).toMatchObject({ ok: false, code: 'network_error' });
    expect(calls).toBe(4);
    expect(await client.open({ url: 'https://a.example/' })).toMatchObject({ ok: false, code: 'circuit_open' });
    expect(calls).toBe(4);
  });

  test('le disjoncteur se referme après un essai réussi', async () => {
    let clock = 0;
    let down = true;
    const client = createBrowserClient({
      fetch: async () => { if (down) throw new TypeError('fetch failed'); return response(200, { status: 'ok' }); },
      token: TOKEN, sleep: async () => {}, now: () => clock, retry: { attempts: 1 }, breaker: { failureThreshold: 1, recoveryMs: 1_000 }
    });
    await client.open({ url: 'https://a.example/' });
    expect((await client.open({ url: 'https://a.example/' })).code).toBe('circuit_open');
    clock = 2_000;
    down = false;
    expect(await client.open({ url: 'https://a.example/' })).toEqual({ ok: true, result: { status: 'ok' } });
    expect(client.breakerStatus().state).toBe('closed');
  });

  test('délai dépassé : timeout, sans nouvel essai', async () => {
    let calls = 0;
    const client = createBrowserClient({
      fetch: (_url, { signal }) => new Promise((_resolve, reject) => { calls += 1; signal.addEventListener('abort', () => reject(new Error('aborted'))); }),
      token: TOKEN, timeoutMs: 20, sleep: async () => {}
    });
    expect(await client.open({ url: 'https://a.example/' })).toMatchObject({ ok: false, code: 'timeout', retryable: false });
    expect(calls).toBe(1);
  });

  test('réponse illisible ; appel annulé ; erreur serveur', async () => {
    const bad = createBrowserClient({ fetch: async () => ({ status: 200, json: async () => { throw new SyntaxError('x'); } }), token: TOKEN });
    expect(await bad.open({ url: 'https://a.example/' })).toMatchObject({ ok: false, code: 'bad_response' });
    const controller = new AbortController();
    controller.abort();
    expect(await bad.open({ url: 'https://a.example/' }, { signal: controller.signal })).toMatchObject({ ok: false, code: 'aborted' });
    const failing = createBrowserClient({ fetch: async () => response(500, { error: { code: 'server_error', message: 'x' } }), token: TOKEN });
    expect(await failing.open({ url: 'https://a.example/' })).toMatchObject({ ok: false, code: 'server_error', status: 500 });
  });

  test('le jeton ne part qu\'en en-tête ; adresse de base vérifiée', async () => {
    const seen = [];
    const client = createBrowserClient({ fetch: async (url, init) => { seen.push({ url, init }); return response(200, { status: 'ok' }); }, token: async () => TOKEN, baseUrl: 'http://127.0.0.1:5008/' });
    await client.open({ url: 'https://a.example/' });
    expect(seen[0].url).toBe('http://127.0.0.1:5008/v1/open');
    expect(seen[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].init.body).not.toContain(TOKEN);
    expect(() => createBrowserClient({ baseUrl: 'ftp://x' })).toThrow(/http/);
  });

  test('moteur local : même interface', async () => {
    const engine = fakeEngine({ open: async () => ({ status: 'busy' }) });
    const local = createLocalBrowser({ engine });
    expect(await local.open({ url: 'https://a.example/' })).toEqual({ ok: false, code: 'busy', retryable: true });
    expect(await local.siteSearch({ url: 'https://a.example/', query: 'q' })).toMatchObject({ ok: true, result: { via: 'form' } });
  });
});
