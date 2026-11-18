const { createAccountLimiter, createApiLimiter, createLoginLimiter } = require('../src');

/* Les limiteurs essayés pour de vrai (plus de simulation d'express-rate-limit) : une requête factice passe dans le
   middleware, et l'on regarde le statut, les en-têtes et l'appel à next(). */
const fakeReq = (overrides = {}) => ({ ip: '203.0.113.10', method: 'GET', path: '/', headers: {}, ...overrides });
const fakeRes = () => {
  const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  res.send = jest.fn((body) => { res.body = body; return res; });
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  return res;
};
const hit = async (limiter, req = fakeReq()) => {
  const res = fakeRes();
  let nextArg = 'not called';
  await limiter(req, res, (arg) => { nextArg = arg; });
  return { passed: nextArg === undefined, error: nextArg instanceof Error ? nextArg : undefined, status: res.statusCode, headers: res.headers, body: res.body, req };
};

describe('rateLimiters', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test('createApiLimiter : 300 requêtes par défaut, puis 429 avec le message et Retry-After', async () => {
    process.env.NODE_ENV = 'production';
    const limiter = createApiLimiter();
    let last;
    for (let i = 0; i < 300; i++) last = await hit(limiter);
    expect(last.passed).toBe(true);
    expect(last.headers['ratelimit-limit']).toBe('300');
    expect(last.headers['ratelimit-remaining']).toBe('0');
    expect(last.headers['ratelimit-policy']).toBe('300;w=900');
    expect(last.headers['x-ratelimit-limit']).toBeUndefined();
    const blocked = await hit(limiter);
    expect(blocked.passed).toBe(false);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ success: false, message: 'Too many requests.' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(890);
    // Une autre adresse garde son compteur.
    expect((await hit(limiter, fakeReq({ ip: '203.0.113.99' }))).passed).toBe(true);
  });

  test('createApiLimiter ne compte pas la machine elle-même hors production, la compte en production', async () => {
    process.env.NODE_ENV = 'development';
    const dev = createApiLimiter({ max: 1 });
    for (let i = 0; i < 5; i++) expect((await hit(dev, fakeReq({ ip: '127.0.0.1' }))).passed).toBe(true);
    expect((await hit(dev, fakeReq({ ip: '203.0.113.10' }))).passed).toBe(true);
    expect((await hit(dev, fakeReq({ ip: '203.0.113.10' }))).passed).toBe(false);
    process.env.NODE_ENV = 'production';
    const prod = createApiLimiter({ max: 1 });
    expect((await hit(prod, fakeReq({ ip: '127.0.0.1' }))).passed).toBe(true);
    expect((await hit(prod, fakeReq({ ip: '127.0.0.1' }))).status).toBe(429);
  });

  test('createApiLimiter donne à chaque zone son compteur et, quand elle le dit, sa limite', async () => {
    process.env.NODE_ENV = 'production';
    const limiter = createApiLimiter({ max: 2, area: (req) => (req.path === '/big' ? { name: 'big', max: 4 } : { name: 'other' }) });
    for (let i = 0; i < 4; i++) expect((await hit(limiter, fakeReq({ path: '/big' }))).passed).toBe(true);
    expect((await hit(limiter, fakeReq({ path: '/big' }))).status).toBe(429);
    // La zone « other » n'a pas été touchée par les requêtes de « big ».
    const other = await hit(limiter, fakeReq({ path: '/small' }));
    expect(other.passed).toBe(true);
    expect(other.req.rateLimit).toEqual(expect.objectContaining({ limit: 2, used: 1, remaining: 1, key: 'other:203.0.113.10' }));
  });

  test('createApiLimiter compte tout un bloc IPv6 /56, et IPv4 écrite en IPv6 comme IPv4', async () => {
    process.env.NODE_ENV = 'production';
    const limiter = createApiLimiter({ max: 1, area: () => ({ name: 'zone' }) });
    expect((await hit(limiter, fakeReq({ ip: '2001:db8:1:2::1' }))).req.rateLimit.key).toBe('zone:2001:db8:1::/56');
    expect((await hit(limiter, fakeReq({ ip: '2001:db8:1:3::99' }))).status).toBe(429);
    expect((await hit(limiter, fakeReq({ ip: '2001:db8:2::1' }))).passed).toBe(true);
    expect((await hit(limiter, fakeReq({ ip: '::ffff:1.1.1.1' }))).req.rateLimit.key).toBe('zone:1.1.1.1');
  });

  test('createApiLimiter prend le magasin donné avant la configuration Redis, et l’initialise avec sa fenêtre', async () => {
    process.env.NODE_ENV = 'production';
    const store = { init: jest.fn(), increment: jest.fn(async () => ({ totalHits: 1, resetTime: new Date(Date.now() + 1000) })) };
    const limiter = createApiLimiter({ redisUrl: 'redis://localhost:6379', store, windowMs: 60_000 });
    expect(limiter.store).toBe(store);
    expect(store.init).toHaveBeenCalledWith({ windowMs: 60_000 });
    await hit(limiter);
    expect(store.increment).toHaveBeenCalledWith('203.0.113.10');
  });

  test('createLoginLimiter appelle onBlocked et rend la réponse configurée', async () => {
    const onBlocked = jest.fn();
    const limiter = createLoginLimiter({ onBlocked, max: 1, message: { error: 'blocked' } });
    const req = fakeReq({ ip: '203.0.113.20' });
    expect((await hit(limiter, req)).passed).toBe(true);
    const blocked = await hit(limiter, req);
    expect(onBlocked).toHaveBeenCalledWith({ ip: '203.0.113.20', req });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'blocked' });
  });

  test('createLoginLimiter : 10 essais par défaut', async () => {
    const limiter = createLoginLimiter();
    for (let i = 0; i < 10; i++) expect((await hit(limiter)).passed).toBe(true);
    const blocked = await hit(limiter);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ success: false, message: 'Too many login attempts. Please try again later.' });
  });

  test('createAccountLimiter compte par identifiant normalisé et rend le contexte du blocage', async () => {
    const onBlocked = jest.fn();
    const limiter = createAccountLimiter({ onBlocked, max: 1 });
    expect((await hit(limiter, fakeReq({ ip: '203.0.113.11', body: { email: 'USER@Example.COM' } }))).req.rateLimit.key).toBe('user@example.com');
    // Même compte, autre adresse : toujours le même compteur.
    const req = fakeReq({ ip: '198.51.100.7', body: { email: 'user@example.com' } });
    const blocked = await hit(limiter, req);
    expect(blocked.status).toBe(429);
    expect(onBlocked).toHaveBeenCalledWith({ identifier: 'user@example.com', ip: '198.51.100.7', req });
    expect(blocked.body).toEqual({ success: false, message: 'Too many attempts for this account. Please try again later.' });
  });

  // Régression : monté avant express.json(), req.body vaut undefined et
  // toutes les tentatives de connexion retombaient sur la clé partagée
  // "unknown" — plus de limite par compte, une seule limite globale pour
  // tous les comptes. Trouvé en auditant createWafMiddleware() (même défaut
  // exact, voir waf.js) : aucun test existant sur ce fichier n'exerçait un
  // req.body non défini.
  describe('createAccountLimiter avec req.body non parsé (mauvais ordre des middlewares)', () => {
    test('retombe sur la clé "unknown" au lieu de planter, mais avertit', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.NODE_ENV = 'development'; // le logger est un no-op en 'test'

      const limiter = createAccountLimiter({});
      const result = await hit(limiter, fakeReq({ ip: '203.0.113.12', body: undefined, headers: { 'content-length': '48' } }));

      expect(result.req.rateLimit.key).toBe('unknown');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/express\.json|unknown/i);

      warnSpy.mockRestore();
    });

    test('une requête sans corps (Express 5 laisse req.body à undefined) ne fait pas avertir', async () => {
      jest.resetModules();
      const { createAccountLimiter: fresh } = require('../src');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.NODE_ENV = 'development';

      expect((await hit(fresh({}), fakeReq({ ip: '203.0.113.14', body: undefined, headers: {} }))).req.rateLimit.key).toBe('unknown');
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    test('un keyGenerator personnalisé contourne complètement ce défaut', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.NODE_ENV = 'development';

      const customKeyGenerator = jest.fn(() => 'clé-personnalisée');
      const limiter = createAccountLimiter({ keyGenerator: customKeyGenerator });

      expect((await hit(limiter, fakeReq({ ip: '203.0.113.13', body: undefined }))).req.rateLimit.key).toBe('clé-personnalisée');
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  test('avec redisUrl seul, les limites de l’API, de la connexion et des comptes ne partagent pas leurs compteurs', () => {
    const url = 'redis://127.0.0.1:1';
    const limiters = [createApiLimiter({ redisUrl: url }), createLoginLimiter({ redisUrl: url }), createAccountLimiter({ redisUrl: url })];
    try {
      expect(limiters.map((l) => l.store.prefix)).toEqual(['rl:api:', 'rl:login:', 'rl:account:']);
    } finally {
      for (const limiter of limiters) limiter.store.shutdown();
    }
  });

  test('avec redisUrl seul, des requêtes ordinaires ne bloquent pas la connexion (Redis partagé)', async () => {
    process.env.NODE_ENV = 'production';
    const { createRedisRateLimitStore } = require('../src');
    const data = new Map();
    // Un faux Redis partagé : même serveur pour les deux limiteurs, comme en production.
    const sendCommand = async (args) => {
      if (args[0] === 'DEL') return data.delete(args[1]) ? 1 : 0;
      const key = args[3];
      const value = (data.get(key) || 0) + 1;
      data.set(key, value);
      return [value, 60_000];
    };
    const api = createApiLimiter({ store: createRedisRateLimitStore({ sendCommand, prefix: 'rl:api:' }) });
    const login = createLoginLimiter({ store: createRedisRateLimitStore({ sendCommand, prefix: 'rl:login:' }) });
    for (let i = 0; i < 20; i++) expect((await hit(api)).passed).toBe(true);
    expect((await hit(login)).passed).toBe(true);
  });

  test('sans redisUrl ni magasin, chaque limiteur a son propre compteur en mémoire', async () => {
    process.env.NODE_ENV = 'production';
    const a = createApiLimiter({ max: 1 });
    const b = createApiLimiter({ max: 1 });
    expect((await hit(a)).passed).toBe(true);
    expect((await hit(b)).passed).toBe(true);
    expect(a.store).not.toBe(b.store);
  });
});
