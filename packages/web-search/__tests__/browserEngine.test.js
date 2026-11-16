/*
 * Le moteur du navigateur sur vrai Chromium, contre un site de pages pièges
 * local. Sautés sans Playwright, sans Chromium ou sans openssl.
 */
const net = require('net');
const { createBrowserEngine } = require('../src/browser/engine');
const { startTrapSite, fakeResolve, localFetchRobots, playwrightReady, hasOpenssl } = require('./browserSite');

const ready = playwrightReady() && hasOpenssl();
const suite = ready ? describe : describe.skip;
if (!ready) console.warn('browserEngine.test.js : sauté (Playwright, Chromium ou openssl absent).');

jest.setTimeout(60_000);

suite('moteur du navigateur (vrai Chromium)', () => {
  let site;
  let engine;
  /* Le relais de sortie se connecte au site local pour les noms *.example (après son contrôle). */
  const toSite = ({ port }) => net.connect({ host: '127.0.0.1', port });
  const open = (path, extra = {}) => engine.open({ url: `${site.origin}${path}`, ...extra });

  beforeAll(async () => {
    site = await startTrapSite();
    engine = createBrowserEngine({
      resolve: fakeResolve,
      ports: [site.port],
      connect: toSite,
      insecureTls: true,
      fetchRobots: localFetchRobots(site.port),
      pageTimeoutMs: 8_000,
      requestTimeoutMs: 12_000,
      settleMs: 1_500
    });
    await engine.start();
  });

  afterAll(async () => {
    await engine?.close();
    await site?.close();
  });

  afterEach(() => {
    expect(site.hits).toEqual([]);
  });

  test('lit une page construite en JavaScript, avec ses liens numérotés (même site d\'abord)', async () => {
    const page = await open('/js');
    expect(page.status).toBe('ok');
    expect(page.text).toContain('Rendu par JavaScript');
    expect(page.text).toContain('mot319');
    expect(page.text).not.toContain('Chargement');
    expect(page.title).toBe('Piège');
    expect(page.lang).toBe('fr');
    expect(page.publishedAt).toBe('2026-11-01T10:00:00.000Z');
    expect(page.canonical).toBe(`${site.origin}/js`);
    expect(page.links.map((link) => [link.n, link.url, link.sameSite])).toEqual([
      [1, `${site.origin}/page2`, true],
      [2, `https://autre.example:${site.port}/x`, false]
    ]);
    expect(page.screenshot).toBeUndefined();
  });

  test('capture d\'écran seulement sur demande, 1280 × 800 au plus', async () => {
    const page = await open('/page2', { screenshot: true });
    expect(page.status).toBe('ok');
    expect(page.screenshot.mediaType).toBe('image/png');
    const png = Buffer.from(page.screenshot.data, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBeLessThanOrEqual(1280);
    expect(png.readUInt32BE(20)).toBeLessThanOrEqual(800);
  });

  test('masque les bandeaux de cookies et fenêtres d\'abonnement sans cliquer', async () => {
    const page = await open('/cookies');
    expect(page.text).toContain('Le vrai contenu de la page.');
    expect(page.text).not.toContain('cookies');
    expect(page.text).not.toContain('Abonnez-vous');
    expect(page.removed.overlays).toBe(2);
  });

  test('retire le texte caché qui donne des ordres, et les liens cachés', async () => {
    const page = await open('/cache');
    expect(page.text).toContain('Contenu visible.');
    for (let i = 1; i <= 9; i += 1) expect(page.text).not.toContain(`ORDRE${i}`);
    expect(page.links).toEqual([]);
  });

  test('refuse une redirection vers une IP interne', async () => {
    const page = await open('/redir-ip');
    expect(page.status).toBe('blocked');
  });

  test('refuse une redirection vers un nom qui résout en adresse privée', async () => {
    const page = await open('/redir-nom');
    expect(page.status).toBe('blocked');
  });

  test('refuse une redirection vers http', async () => {
    const page = await open('/redir-http');
    expect(page.status).toBe('blocked');
    expect(page.reason).toBe('protocol');
  });

  test('une navigation en JavaScript vers l\'intérieur n\'aboutit pas', async () => {
    const page = await open('/js-redir');
    expect(page.status).toBe('blocked');
    expect(page.reason).toBe('address');
  });

  test('images, fetch, balises et WebSocket vers l\'intérieur sont coupés', async () => {
    const page = await open('/sorties');
    expect(page.status).toBe('ok');
    expect(page.blockedRequests).toBeGreaterThanOrEqual(6);
  });

  test('une WebSocket wss vers un site public passe', async () => {
    const page = await open('/socket-public');
    expect(page.status).toBe('ok');
    site.hits.splice(0, site.hits.length, ...site.hits.filter((hit) => hit !== `websocket piege.example:${site.port}/socket`));
  });

  test('fenêtre surgissante fermée, boîtes de dialogue refusées', async () => {
    const page = await open('/popup');
    expect(page.status).toBe('ok');
    expect(page.text).toContain('Page avec fenêtre surgissante.');
  });

  test('un téléchargement forcé n\'est pas lu', async () => {
    const page = await open('/telechargement');
    expect(page.status).toBe('unsupported_type');
  });

  test('au-delà du budget de ressources, les requêtes suivantes sont coupées', async () => {
    const small = createBrowserEngine({
      resolve: fakeResolve, ports: [site.port], connect: toSite, insecureTls: true,
      fetchRobots: localFetchRobots(site.port), maxResourceBytes: 3_000_000, settleMs: 1_500
    });
    try {
      const page = await small.open({ url: `${site.origin}/lourde` });
      expect(page.status).toBe('ok');
      expect(page.resourceLimitReached).toBe(true);
      expect(page.truncated).toBe(true);
      expect(page.blockedRequests).toBeGreaterThanOrEqual(1);
    } finally {
      await small.close();
    }
  });

  test('une page énorme est coupée à maxTextChars', async () => {
    const small = createBrowserEngine({
      resolve: fakeResolve, ports: [site.port], connect: toSite, insecureTls: true,
      fetchRobots: localFetchRobots(site.port), maxTextChars: 10_000, settleMs: 500
    });
    try {
      const page = await small.open({ url: `${site.origin}/enorme` });
      expect(page.status).toBe('ok');
      expect(page.text.length).toBeLessThanOrEqual(10_000);
      expect(page.truncated).toBe(true);
    } finally {
      await small.close();
    }
  });

  test('statut HTTP en erreur', async () => {
    const page = await open('/absente');
    expect(page.status).toBe('bad_status');
    expect(page.httpStatus).toBe(404);
  });

  test('robots.txt : le groupe de l\'agent s\'applique', async () => {
    expect((await open('/interdit-agent')).status).toBe('robots_disallowed');
    expect((await open('/prive')).status).toBe('ok');
  });

  test('trop de redirections', async () => {
    const page = await open('/boucle');
    expect(page.status).toBe('too_many_redirects');
  });

  test('politique de sites de la demande : allowDomains et blockDomains', async () => {
    expect((await open('/page2', { allowDomains: ['autre.example'] })).status).toBe('domain_refused');
    expect((await open('/page2', { blockDomains: ['piege.example'] })).status).toBe('domain_refused');
    expect((await open('/page2', { allowDomains: ['piege.example'] })).status).toBe('ok');
  });

  test('une adresse interne donnée directement est refusée', async () => {
    const page = await engine.open({ url: `https://127.0.0.1:${site.port}/secret` });
    expect(page.status).toBe('blocked');
  });

  test('une page trop lente rend timeout', async () => {
    const page = await open('/lente');
    expect(page.status).toBe('timeout');
  });

  test('recherche interne par OpenSearch, sans clic', async () => {
    const result = await engine.siteSearch({ url: `${site.origin}/os`, query: 'fusée verte' });
    expect(result.status).toBe('ok');
    expect(result.via).toBe('opensearch');
    expect(result.searchUrl).toBe(`${site.origin}/resultats?q=fus%C3%A9e%20verte&p=1`);
    expect(result.text).toContain('Résultats pour fusée verte');
  });

  test('recherche interne par formulaire GET à un champ', async () => {
    const result = await engine.siteSearch({ url: `${site.origin}/formulaire`, query: 'pomme' });
    expect(result.status).toBe('ok');
    expect(result.via).toBe('form');
    expect(result.searchUrl).toBe(`${site.origin}/chercher?lang=fr&mots=pomme`);
    expect(result.text).toContain('Résultats pour pomme');
  });

  test('pas de recherche interne : no_site_search ; jamais vers un moteur', async () => {
    expect((await engine.siteSearch({ url: `${site.origin}/sans-recherche`, query: 'x' })).status).toBe('no_site_search');
    expect((await engine.siteSearch({ url: `${site.origin}/os-moteur`, query: 'x' })).status).toBe('no_site_search');
    expect((await engine.siteSearch({ url: 'https://www.google.com/', query: 'x' })).status).toBe('search_engine_refused');
  });

  test('deux demandes ne partagent ni cookies ni stockage', async () => {
    const first = await open('/page2');
    const second = await open('/page2');
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
  });

  test('santé : version de Chromium, cloisonnement, file', async () => {
    const health = await engine.health();
    expect(health.ok).toBe(true);
    expect(health.sandbox).toBe(true);
    expect(health.chromium).toMatch(/^\d+\./);
    expect(health.userAgent).toMatch(/^Mozilla\/5\.0 \(compatible; AstratraWebBrowser\/\d+\.\d+\.\d+; \+https:\/\/github\.com\/emch04\/astratra/);
    expect(health.max).toBe(2);
  });
});
