'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRandom, gen, payloads, checkProperty, assertProperty, fuzz, assertFuzz, defaultExpectedError,
  forgeJwt, jwtAttacks, jwtClaimAttacks, decodeJwtPart,
} = require('../security');

test('le hasard à graine fixe rejoue la même suite, et deux graines diffèrent', () => {
  const a = createRandom(42);
  const b = createRandom(42);
  const c = createRandom(43);
  const take = (r) => Array.from({ length: 20 }, () => r.uint32());
  const fromA = take(a);
  assert.deepEqual(fromA, take(b));
  assert.notDeepEqual(fromA, take(c));
  const r = createRandom('texte');
  for (let i = 0; i < 1000; i++) {
    const n = r.int(-3, 3);
    assert.ok(n >= -3 && n <= 3 && Number.isInteger(n));
  }
  assert.throws(() => r.int(2, 1), RangeError);
  assert.throws(() => r.pick([]), RangeError);
});

test('le catalogue fournit chaque famille d’attaques, et les clés piégées sont de vraies clés propres', () => {
  for (const name of ['sqlInjection', 'xss', 'pathTraversal', 'commandInjection', 'headerInjection', 'unicode', 'ssrfUrls', 'ipv6SameSubnet', 'filenames', 'emails']) {
    assert.ok(Array.isArray(payloads[name]) && payloads[name].length >= 5, name);
  }
  assert.ok(payloads.unicode.includes('\uD800'));
  const polluted = payloads.prototypePollution()[0];
  assert.ok(Object.prototype.hasOwnProperty.call(polluted, '__proto__'));
  assert.equal({}.polluted, undefined);
  assert.ok(payloads.invalidUtf8().every(Buffer.isBuffer));
  assert.ok(payloads.noSqlOperators().some((o) => '$where' in o));
  // Chaque appel fabrique des objets neufs : un essai qui les modifie ne gâche pas le suivant.
  assert.notEqual(payloads.noSqlOperators()[0], payloads.noSqlOperators()[0]);
});

test('une propriété fausse est trouvée et réduite à son plus petit exemple', async () => {
  const report = await checkProperty(gen.array(gen.integer(0, 1000), { max: 30 }), (list) => list.every((n) => n < 500), { seed: 7 });
  assert.equal(report.passed, false);
  assert.deepEqual(report.counterexample, [500]);
  await assert.rejects(() => assertProperty(gen.string({ max: 40 }), (s) => !s.includes('z'), { seed: 3, name: 'sans z' }), (error) => {
    assert.match(error.message, /sans z: property failed/);
    assert.match(error.message, /SECURITY_TEST_SEED=3/);
    assert.match(error.message, /"z"/);
    return true;
  });
});

test('une propriété vraie passe toutes ses tentatives', async () => {
  const report = await assertProperty(gen.record({ a: gen.integer(), b: gen.string() }), ({ a, b }) => typeof a === 'number' && typeof b === 'string', { runs: 300 });
  assert.equal(report.passed, true);
  assert.equal(report.runs, 300);
});

test('SECURITY_TEST_SEED rejoue un échec à l’identique', async () => {
  const property = (s) => s.length < 10;
  const first = await checkProperty(gen.string({ max: 30 }), property, { seed: 11 });
  process.env.SECURITY_TEST_SEED = String(first.seed);
  try {
    const again = await checkProperty(gen.string({ max: 30 }), property, { seed: 999 });
    assert.equal(again.run, first.run);
    assert.deepEqual(again.original, first.original);
  } finally {
    delete process.env.SECURITY_TEST_SEED;
  }
});

/** Un analyseur fautif : il plante sur un guillemet seul et boucle longtemps sur une longue suite de « a ». */
function fragileParser(input) {
  const text = String(input);
  if (text.includes('"') && text.split('"').length % 2 === 0) return text.match(/"([^"]*)"/)[1].length;
  if (/^(a+)+$/.test(text.slice(0, 28) + '!')) return 0;
  return text.length;
}

test('le fuzz trouve le plantage et la lenteur d’un analyseur fautif, avec la graine pour le rejouer', async () => {
  const report = await fuzz(fragileParser, { generator: gen.oneOf(gen.mutated(['"ok"', 'a'.repeat(28), 'texte']), gen.hostileString()), runs: 600, seed: 5, timeoutMs: 50 });
  assert.equal(report.passed, false);
  const kinds = new Set(report.failures.map((f) => f.kind));
  assert.ok(kinds.has('crash'), `kinds: ${[...kinds]}`);
  await assert.rejects(() => assertFuzz(fragileParser, { generator: gen.mutated(['"ok"']), runs: 300, seed: 5, name: 'analyseur' }), /analyseur: fuzz found .* SECURITY_TEST_SEED=5/s);
});

test('le fuzz accepte les refus voulus et vérifie une règle sur chaque réponse', async () => {
  const strict = (input) => {
    if (typeof input !== 'string' || input.length > 20) throw Object.assign(new Error('refusé'), { status: 400 });
    return input.toUpperCase();
  };
  const ok = await assertFuzz(strict, { generator: gen.oneOf(gen.hostileString(), gen.json()), runs: 400, check: (out) => typeof out === 'string' });
  assert.equal(ok.passed, true);
  const leaky = await fuzz((s) => `<p>${s}</p>`, { generator: gen.elements(payloads.xss), runs: 50, check: (html) => (/<script|onerror|onload/i.test(html) ? 'unescaped HTML' : true) });
  assert.equal(leaky.passed, false);
  assert.equal(leaky.failures[0].kind, 'check');
});

test('le fuzz arrête une cible asynchrone qui ne répond pas', async () => {
  const report = await fuzz(() => new Promise(() => {}), { generator: gen.constant('x'), runs: 2, timeoutMs: 20 });
  assert.equal(report.failures[0].kind, 'timeout');
});

test('un refus voulu porte un statut 4xx ou un code à soi ; une TypeError est un plantage', () => {
  assert.equal(defaultExpectedError(Object.assign(new Error('x'), { status: 403 })), true);
  assert.equal(defaultExpectedError(Object.assign(new Error('x'), { code: 'INVALID_TOKEN' })), true);
  assert.equal(defaultExpectedError(Object.assign(new TypeError('x'), { status: 400 })), false);
  assert.equal(defaultExpectedError(Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' })), false);
  assert.equal(defaultExpectedError(new Error('sans code')), false);
});

test('les générateurs JSON et mutés produisent des entrées variées et hostiles', () => {
  const random = createRandom(1);
  const values = Array.from({ length: 300 }, () => gen.json().generate(random));
  assert.ok(values.some((v) => v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, '__proto__')));
  assert.ok(values.some(Array.isArray));
  const mutated = Array.from({ length: 300 }, () => gen.mutated(['{"a":1}']).generate(random));
  assert.ok(new Set(mutated).size > 100);
  const bytes = gen.mutated([Buffer.from('abc')]).generate(random);
  assert.ok(Buffer.isBuffer(bytes));
});

test('les jetons piégés : une vérification correcte les refuse tous, une vérification naïve se fait prendre', () => {
  const crypto = require('node:crypto');
  const secret = crypto.randomBytes(32);
  const token = forgeJwt({ payload: { sub: 'u1', role: 'user', exp: Math.floor(Date.now() / 1000) + 600 }, secret });
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const attacks = jwtAttacks(token, { publicKey });
  assert.ok(attacks.length >= 40);

  const strictVerify = (candidate) => {
    const parts = String(candidate).split('.');
    if (parts.length !== 3) return false;
    const header = decodeJwtPart(parts[0]);
    if (!header || header.alg !== 'HS256') return false;
    const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], 'base64url');
    if (given.toString('base64url') !== parts[2] || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    const payload = decodeJwtPart(parts[1]);
    return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.exp === 'number' && payload.exp > Date.now() / 1000;
  };
  assert.equal(strictVerify(token), true);
  for (const attack of attacks) assert.equal(strictVerify(attack.token), false, attack.name);

  // La vérification qui croit l'en-tête : « none » passe.
  const naive = (candidate) => {
    const [h, p, s] = String(candidate).split('.');
    const header = decodeJwtPart(h);
    if (header && String(header.alg).toLowerCase() === 'none') return true;
    return s === crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  };
  assert.ok(attacks.some((attack) => naive(attack.token)));
});

test('les revendications piégées couvrent l’échéance, l’audience et l’émetteur', () => {
  const claims = jwtClaimAttacks({ sub: 'u1', aud: 'app', iss: 'auth' }, { audience: 'app', issuer: 'auth' });
  const names = claims.map((c) => c.name);
  for (const name of ['expired', 'not yet valid (nbf in one hour)', 'other audience', 'audience missing', 'other issuer', 'issuer missing']) assert.ok(names.includes(name), name);
  assert.equal('aud' in claims.find((c) => c.name === 'audience missing').payload, false);
  assert.equal('iss' in claims.find((c) => c.name === 'issuer missing').payload, false);
  assert.throws(() => forgeJwt({ payload: {}, alg: 'RS256' }), /only signs/);
  assert.match(forgeJwt({ payload: {}, alg: 'none' }), /\.$/);
});
