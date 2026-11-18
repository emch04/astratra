const path = require('node:path');
const fs = require('node:fs');
const {
  payloads, gen, assertFuzz, assertAtMost, faults, withFault, assertVectors, assertSafeRegex, assertLinearTime, extractRegexLiterals,
} = require('@astratra/testkit/security');
const { createRateLimit, createMemoryRateLimitStore, rateLimitKeyForIp, createRedisRateLimitStore } = require('../src');

// Le moteur du limiteur (src/rateLimit.js, src/redisRateLimitStore.js), écrit sans dépendance : essais classiques,
// négatifs et d'attaque, avec les outils de @astratra/testkit/security.

const fakeReq = (ip = '203.0.113.10', extra = {}) => ({ ip, method: 'POST', path: '/', headers: {}, ...extra });
const fakeRes = () => {
  const listeners = {};
  const res = { statusCode: 200, headers: {}, headersSent: false, writableFinished: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.send = (body) => { res.body = body; return res; };
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.on = (event, fn) => { (listeners[event] ||= []).push(fn); return res; };
  res.finish = (status) => { res.statusCode = status; res.writableFinished = true; (listeners.finish || []).forEach((fn) => fn()); };
  return res;
};
const hit = async (limiter, req = fakeReq()) => {
  const res = fakeRes();
  let nextArg = 'not called';
  await limiter(req, res, (arg) => { nextArg = arg; });
  return { passed: nextArg === undefined, error: nextArg instanceof Error ? nextArg : undefined, status: res.statusCode, headers: res.headers, body: res.body, req, res };
};

/** Un faux Redis qui exécute les trois scripts du magasin comme Redis le ferait (compteur, expiration, lecture). */
function fakeRedis() {
  const data = new Map();
  const alive = (key) => {
    const entry = data.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) data.delete(key);
    return data.get(key);
  };
  const pttl = (entry) => (entry.expiresAt === null ? -1 : Math.max(0, entry.expiresAt - Date.now()));
  const commands = [];
  const sendCommand = async (args) => {
    commands.push(args);
    const [name] = args;
    if (name === 'DEL') return data.delete(args[1]) ? 1 : 0;
    if (name !== 'EVAL') throw new Error(`unexpected command ${name}`);
    const [, script, , key, windowArg] = args;
    if (script.includes("'INCR'")) {
      const entry = alive(key) || { value: 0, expiresAt: null };
      entry.value += 1;
      if (entry.expiresAt === null) entry.expiresAt = Date.now() + Number(windowArg);
      data.set(key, entry);
      return [entry.value, pttl(entry)];
    }
    if (script.includes("'DECR'")) {
      const entry = alive(key);
      if (entry && entry.value > 0) entry.value -= 1;
      return entry ? entry.value : 0;
    }
    const entry = alive(key);
    return entry ? [entry.value, pttl(entry)] : null;
  };
  return { sendCommand, data, commands };
}

describe('moteur du limiteur', () => {
  test('fenêtre fixe : la limite tombe à la fin de la fenêtre', async () => {
    const limiter = createRateLimit({ windowMs: 60, max: 2 });
    expect((await hit(limiter)).passed).toBe(true);
    expect((await hit(limiter)).passed).toBe(true);
    expect((await hit(limiter)).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await hit(limiter)).passed).toBe(true);
  });

  test('limite par fonction, message par fonction, statut et en-têtes anciens au choix', async () => {
    const limiter = createRateLimit({ max: (req) => (req.path === '/vip' ? 3 : 1), message: (req) => ({ refused: req.path }), statusCode: 503, standardHeaders: false, legacyHeaders: true });
    expect((await hit(limiter, fakeReq('1.1.1.1', { path: '/vip' }))).headers['x-ratelimit-limit']).toBe('3');
    expect((await hit(limiter, fakeReq('2.2.2.2'))).passed).toBe(true);
    const blocked = await hit(limiter, fakeReq('2.2.2.2'));
    expect(blocked.status).toBe(503);
    expect(blocked.body).toEqual({ refused: '/' });
    expect(blocked.headers['ratelimit-limit']).toBeUndefined();
    expect(blocked.headers['retry-after']).toBeDefined();
    const text = createRateLimit({ max: 0, message: 'non' });
    expect((await hit(text)).body).toBe('non');
  });

  test('skipSuccessfulRequests ne compte que les échecs, skipFailedRequests que les succès', async () => {
    const onlyFailures = createRateLimit({ max: 1, skipSuccessfulRequests: true });
    for (let i = 0; i < 3; i++) (await hit(onlyFailures)).res.finish(200);
    await new Promise((resolve) => setImmediate(resolve));
    const first = await hit(onlyFailures);
    expect(first.passed).toBe(true);
    first.res.finish(401);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await hit(onlyFailures)).status).toBe(429);
    const onlySuccesses = createRateLimit({ max: 1, skipFailedRequests: true });
    for (let i = 0; i < 3; i++) (await hit(onlySuccesses)).res.finish(500);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await hit(onlySuccesses)).passed).toBe(true);
  });

  test('resetKey et getKey', async () => {
    const limiter = createRateLimit({ max: 1 });
    await hit(limiter);
    expect((await limiter.getKey('203.0.113.10')).totalHits).toBe(1);
    expect((await hit(limiter)).status).toBe(429);
    await limiter.resetKey('203.0.113.10');
    expect((await hit(limiter)).passed).toBe(true);
  });

  test('un magasin en panne ne laisse jamais passer sans compter : next(erreur), sauf passOnStoreError', async () => {
    const store = { increment: async () => { throw new Error('store down'); } };
    const closed = await hit(createRateLimit({ store }));
    expect(closed.passed).toBe(false);
    expect(closed.error.message).toBe('store down');
    expect((await hit(createRateLimit({ store, passOnStoreError: true }))).passed).toBe(true);
    const nonsense = await hit(createRateLimit({ store: { increment: async () => ({ totalHits: 'beaucoup' }) } }));
    expect(nonsense.passed).toBe(false);
    expect(nonsense.error).toBeInstanceOf(Error);
    expect(() => createRateLimit({ store: {} })).toThrow(/increment/);
  });

  test('un skip ou une clé qui lève donne next(erreur), jamais un passage', async () => {
    expect((await hit(createRateLimit({ skip: () => { throw new Error('skip cassé'); } }))).error.message).toBe('skip cassé');
    expect((await hit(createRateLimit({ keyGenerator: () => { throw new Error('clé cassée'); } }))).error.message).toBe('clé cassée');
  });

  test('le magasin en mémoire repart à zéro à la fin de la fenêtre, même avant le nettoyage périodique', async () => {
    const store = createMemoryRateLimitStore();
    store.init({ windowMs: 10_000 });
    const realNow = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow);
    try {
      expect((await store.increment('k')).totalHits).toBe(1);
      expect((await store.increment('k')).totalHits).toBe(2);
      clock.mockReturnValue(realNow + 10_001);
      expect((await store.increment('k')).totalHits).toBe(1);
      expect((await store.increment('k')).resetTime.getTime()).toBe(realNow + 10_001 + 10_000);
    } finally {
      clock.mockRestore();
      store.shutdown();
    }
  });

  test('un décompte ne descend jamais sous zéro (sinon des requêtes en plus passeraient)', async () => {
    const store = createMemoryRateLimitStore();
    store.init({ windowMs: 60_000 });
    await store.increment('k');
    await store.decrement('k');
    await store.decrement('k');
    await store.decrement('k');
    expect((await store.increment('k')).totalHits).toBe(1);
    await store.decrement('absente');
    expect(await store.get('absente')).toBeUndefined();
    store.shutdown();
  });

  test('le magasin en mémoire retire les compteurs expirés quand la table déborde', async () => {
    const store = createMemoryRateLimitStore({ maxKeys: 100 });
    store.init({ windowMs: 20 });
    for (let i = 0; i < 100; i++) await store.increment(`k${i}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await store.increment('nouvelle');
    expect(await store.get('k1')).toBeUndefined();
    expect((await store.get('nouvelle')).totalHits).toBe(1);
    store.shutdown();
  });
});

describe('clé des adresses', () => {
  test('différentiel : les mêmes clés qu’express-rate-limit 8.7.4 sur 500 adresses enregistrées', async () => {
    const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ip-keys.json'), 'utf8'));
    await assertVectors(recorded.vectors.map((v) => ({ id: v.ip, input: v.ip, expected: v.key })), (ip) => rateLimitKeyForIp(ip), { source: recorded.source });
  });

  test('toutes les adresses d’un même bloc /64 du catalogue partagent une clé', () => {
    const keys = new Set(payloads.ipv6SameSubnet.map((ip) => rateLimitKeyForIp(ip)));
    expect([...keys]).toEqual(['2001:db8:1::/56']);
  });

  test('ne plante jamais, quelle que soit l’adresse, et reste linéaire', async () => {
    await assertFuzz((ip) => {
      const key = rateLimitKeyForIp(ip);
      if (typeof key !== 'string') throw new TypeError('not a string');
      return key;
    }, { generator: gen.oneOf(gen.hostileString(), gen.mutated(['2001:db8:1:2::1', '::ffff:1.2.3.4', '1.2.3.4', 'fe80::1%eth0']), gen.string({ max: 80, alphabet: '0123456789abcdef:.%' })), runs: 3000 });
    assertLinearTime((ip) => rateLimitKeyForIp(ip), { build: (n) => `${'1:'.repeat(n)}::1.2.3.4`, sizes: [10_000, 20_000, 40_000, 80_000] });
    for (const regex of extractRegexLiterals(fs.readFileSync(path.join(__dirname, '../src/rateLimit.js'), 'utf8'))) await assertSafeRegex(regex);
  });

  test('les en-têtes d’adresse envoyés par le client ne changent pas la clé (seul req.ip compte)', async () => {
    const limiter = createRateLimit({ max: 1 });
    expect((await hit(limiter)).passed).toBe(true);
    for (const headers of payloads.ipSpoofHeaders) expect((await hit(limiter, fakeReq('203.0.113.10', { headers }))).status).toBe(429);
  });
});

describe('attaques sur le limiteur', () => {
  test('50 requêtes au même instant : jamais plus que la limite (mémoire)', async () => {
    const limiter = createRateLimit({ max: 10 });
    const result = await assertAtMost(() => hit(limiter), { max: 10, concurrency: 50, isSuccess: (o) => o.ok && o.value.passed });
    expect(result.successes).toHaveLength(10);
  });

  test('50 requêtes au même instant : jamais plus que la limite (Redis)', async () => {
    const redis = fakeRedis();
    const store = createRedisRateLimitStore({ sendCommand: redis.sendCommand, prefix: 'essai:' });
    const limiter = createRateLimit({ max: 10, store });
    const result = await assertAtMost(() => hit(limiter), { max: 10, concurrency: 50, isSuccess: (o) => o.ok && o.value.passed });
    expect(result.successes).toHaveLength(10);
  });

  test('changer d’adresse dans son bloc IPv6 ne donne pas un compteur neuf', async () => {
    const limiter = createRateLimit({ max: 3 });
    const outcomes = [];
    for (const ip of payloads.ipv6SameSubnet) outcomes.push((await hit(limiter, fakeReq(ip))).passed);
    expect(outcomes.filter(Boolean)).toHaveLength(3);
  });
});

describe('magasin Redis', () => {
  test('les clés sont hachées et préfixées : ni adresse ni e-mail en clair, longueur bornée', async () => {
    const redis = fakeRedis();
    const store = createRedisRateLimitStore({ sendCommand: redis.sendCommand, prefix: 'app:limite:' });
    store.init({ windowMs: 60_000 });
    await store.increment('user@example.test');
    await store.increment('x'.repeat(100_000));
    const keys = [...redis.data.keys()];
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(/^app:limite:[0-9a-f]{64}$/);
    expect(JSON.stringify(redis.commands)).not.toContain('user@example.test');
  });

  test('compte, décompte, lit, remet à zéro, et la fenêtre expire', async () => {
    const redis = fakeRedis();
    const store = createRedisRateLimitStore({ sendCommand: redis.sendCommand });
    store.init({ windowMs: 50 });
    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
    await store.decrement('k');
    expect((await store.get('k')).totalHits).toBe(1);
    await store.resetKey('k');
    expect(await store.get('k')).toBeUndefined();
    await store.increment('k');
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect((await store.increment('k')).totalHits).toBe(1);
  });

  test('Redis qui tombe : la limite continue de s’appliquer, comptée en mémoire, puis Redis reprend', async () => {
    const redis = fakeRedis();
    const target = { sendCommand: redis.sendCommand };
    const store = createRedisRateLimitStore({ sendCommand: (args) => target.sendCommand(args), retryAfterMs: 20 });
    const limiter = createRateLimit({ max: 2, store });
    await withFault(target, 'sendCommand', faults.rejecting(), async () => {
      expect((await hit(limiter)).passed).toBe(true);
      expect((await hit(limiter)).passed).toBe(true);
      const blocked = await hit(limiter);
      expect(blocked.passed).toBe(false);
      expect(blocked.status).toBe(429);
    });
    // Redis revient : après le délai du disjoncteur, son compteur à lui reprend (il n'avait rien vu de la coupure).
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await hit(limiter, fakeReq('198.51.100.1'))).passed).toBe(true);
    expect(redis.data.size).toBe(1);
  });

  test('Redis figé (connexion ouverte, aucune réponse) : la requête n’attend que le délai, puis la mémoire compte sans attendre', async () => {
    const redis = fakeRedis();
    const target = { sendCommand: redis.sendCommand };
    const store = createRedisRateLimitStore({ sendCommand: (args) => target.sendCommand(args), commandTimeoutMs: 50, retryAfterMs: 1000 });
    const limiter = createRateLimit({ max: 2, store });
    await withFault(target, 'sendCommand', faults.hanging(), async () => {
      const started = Date.now();
      expect((await hit(limiter)).passed).toBe(true);
      expect(Date.now() - started).toBeLessThan(500);
      const quick = Date.now();
      expect((await hit(limiter)).passed).toBe(true);
      expect((await hit(limiter)).status).toBe(429);
      expect(Date.now() - quick).toBeLessThan(50);
    });
  });

  test('la connexion propre au magasin échoue vite hors connexion (pas de file d’attente)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/redisRateLimitStore.js'), 'utf8');
    expect(source).toMatch(/disableOfflineQueue: true/);
    expect(source).toMatch(/connectTimeout: \d+/);
  });

  test('sans redisUrl ni connexion, aucun magasin Redis n’est créé', () => {
    expect(createRedisRateLimitStore({})).toBeUndefined();
  });
});
