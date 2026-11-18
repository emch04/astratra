const crypto = require('node:crypto');
// Les jetons des essais viennent du module du paquet (jsonwebtoken retiré ; même forme de jeton, voir jwt.test.js).
const { signJwt, verifyJwt, decodeJwt } = require('../src');
const jwt = { sign: signJwt, verify: verifyJwt, decode: decodeJwt };
const { jwtAttacks, jwtClaimAttacks, forgeJwt, assertFuzz, gen, payloads, assertConstantTime } = require('@astratra/testkit/security');
const { createAuthMiddleware, createCsrfMiddleware } = require('../src');

// Les essais de sécurité de @astratra/testkit appliqués aux gardes de ce paquet : chaque jeton piégé doit être refusé,
// le lecteur de jetons ne doit jamais planter, et la comparaison du jeton CSRF ne doit pas dépendre de sa valeur.

const SECRET = crypto.randomBytes(48).toString('hex');
const LEGACY = crypto.randomBytes(48).toString('hex');
const OPTIONS = { secret: SECRET, legacySecret: LEGACY, issuer: 'auth.example.test', audience: 'app.example.test' };

const call = async (middleware, token) => {
  const req = { cookies: {}, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; } };
  let passed = false;
  await middleware(req, res, () => { passed = true; });
  return { passed, status: passed ? 200 : res.statusCode, user: req.user };
};

const validToken = (secret = SECRET, claims = {}) =>
  jwt.sign({ id: 'u1', role: 'user', ...claims }, secret, { algorithm: 'HS256', expiresIn: '10m', issuer: OPTIONS.issuer, audience: OPTIONS.audience });

describe('jetons piégés (testkit/security)', () => {
  const middleware = createAuthMiddleware(OPTIONS);

  test('un jeton valide passe, avec la clé courante comme avec l’ancienne', async () => {
    expect((await call(middleware, validToken())).passed).toBe(true);
    expect((await call(middleware, validToken(LEGACY))).passed).toBe(true);
  });

  test('chaque variante falsifiée d’un jeton valide est refusée (401)', async () => {
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    for (const base of [validToken(), validToken(LEGACY)]) {
      for (const attack of jwtAttacks(base, { publicKey })) {
        const result = await call(middleware, attack.token);
        expect({ name: attack.name, passed: result.passed }).toEqual({ name: attack.name, passed: false });
      }
    }
  });

  test('des revendications fausses signées avec la vraie clé sont refusées', async () => {
    for (const { name, payload } of jwtClaimAttacks({ id: 'u1', role: 'user', iss: OPTIONS.issuer, aud: OPTIONS.audience }, { audience: OPTIONS.audience, issuer: OPTIONS.issuer })) {
      for (const secret of [SECRET, LEGACY]) {
        const token = forgeJwt({ payload, secret });
        const result = await call(middleware, token);
        expect({ name, passed: result.passed }).toEqual({ name, passed: false });
      }
    }
  });

  test('un léger décalage d’horloge entre serveurs reste accepté (iat 30 s dans le futur), au-delà d’une minute non', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { id: 'u1', iss: OPTIONS.issuer, aud: OPTIONS.audience, exp: now + 600 };
    expect((await call(middleware, forgeJwt({ payload: { ...claims, iat: now + 30 }, secret: SECRET }))).passed).toBe(true);
    expect((await call(middleware, forgeJwt({ payload: { ...claims, iat: now + 120 }, secret: SECRET }))).passed).toBe(false);
    const strict = createAuthMiddleware({ ...OPTIONS, clockTolerance: 0 });
    expect((await call(strict, forgeJwt({ payload: { ...claims, iat: now + 30 }, secret: SECRET }))).passed).toBe(false);
  });

  test('un jeton signé avec une autre clé, ou avec la clé en HS512 quand seul HS256 est permis, est refusé', async () => {
    expect((await call(middleware, validToken(crypto.randomBytes(48).toString('hex')))).passed).toBe(false);
    const hs512 = jwt.sign({ id: 'u1' }, SECRET, { algorithm: 'HS512', expiresIn: '10m', issuer: OPTIONS.issuer, audience: OPTIONS.audience });
    expect((await call(middleware, hs512)).passed).toBe(false);
  });

  test('le lecteur de jetons ne plante jamais et ne laisse rien passer, quelle que soit l’entrée', async () => {
    const base = validToken();
    await assertFuzz(async (token) => {
      const result = await call(middleware, token);
      if (result.passed && token !== base) throw new Error('accepted a token that is not the valid one');
      return result;
    }, {
      generator: gen.oneOf(gen.hostileString(), gen.mutated([base]), gen.string({ max: 400, alphabet: 'hostile' })),
      runs: 1500,
      timeoutMs: 200,
      check: (result) => [200, 401].includes(result.status) || `status ${result.status}`,
    });
  });

  test('les en-têtes Authorization hostiles sont refusés sans planter', async () => {
    for (const value of [...payloads.headerInjection, ...payloads.unicode, '', 'Bearer', 'Bearer ', `Bearer ${'a'.repeat(100_000)}`]) {
      const req = { cookies: {}, headers: { authorization: value } };
      const res = { status(code) { this.code = code; return this; }, json() { return this; } };
      let passed = false;
      await middleware(req, res, () => { passed = true; });
      expect(passed).toBe(false);
      expect(res.code).toBe(401);
    }
  });
});

describe('jeton CSRF (testkit/security)', () => {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = createCsrfMiddleware();
  const wrongAtStart = (token[0] === 'a' ? 'b' : 'a') + token.slice(1);
  const wrongAtEnd = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
  const attempt = (header) => {
    const req = { method: 'POST', cookies: { astratra_csrf: token }, headers: { 'x-csrf-token': header } };
    const res = { status() { return this; }, json() { return this; }, setHeader() {}, getHeader() {} };
    csrf(req, res, () => {});
  };

  test('la comparaison ne dépend pas du caractère faux (temps constant)', () => {
    assertConstantTime(attempt, { classes: [() => wrongAtStart, () => wrongAtEnd], samples: 3_000, name: 'CSRF' });
  });

  test('un jeton faux, coupé ou répété est refusé, le bon passe', () => {
    const run = (header) => {
      const req = { method: 'POST', cookies: { astratra_csrf: token }, headers: { 'x-csrf-token': header } };
      let status = 200;
      const res = { status(code) { status = code; return this; }, json() { return this; }, setHeader() {}, getHeader() {} };
      let passed = false;
      csrf(req, res, () => { passed = true; });
      return passed ? 200 : status;
    };
    expect(run(token)).toBe(200);
    for (const header of [wrongAtStart, wrongAtEnd, token.slice(1), `${token}a`, token.toUpperCase(), [token, token], `${token}\u0000`, ...payloads.unicode]) {
      expect(run(header)).toBe(403);
    }
  });
});
