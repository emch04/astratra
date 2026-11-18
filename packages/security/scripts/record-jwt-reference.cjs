'use strict';

/*
 * Enregistre le comportement de jsonwebtoken 9 (signature et vérification), une fois, avant de le remplacer : les
 * vecteurs gardés dans __tests__/fixtures/jwt-reference.json prouvent ensuite que le module du paquet répond pareil.
 * Lancé à la main tant que jsonwebtoken est installé (node scripts/record-jwt-reference.cjs).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { jwtAttacks, jwtClaimAttacks, forgeJwt, gen, createRandom } = require('@astratra/testkit/security');

const random = createRandom('jwt-reference');
const pem = (key, type) => key.export({ type, format: 'pem' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec256 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ec384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
const ec521 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-521' });
const keys = {
  hs: 'secret-de-reference-assez-long-pour-hs512-0123456789abcdef',
  rsaPrivate: pem(rsa.privateKey, 'pkcs8'), rsaPublic: pem(rsa.publicKey, 'spki'),
  ec256Private: pem(ec256.privateKey, 'pkcs8'), ec256Public: pem(ec256.publicKey, 'spki'),
  ec384Private: pem(ec384.privateKey, 'pkcs8'), ec384Public: pem(ec384.publicKey, 'spki'),
  ec521Private: pem(ec521.privateKey, 'pkcs8'), ec521Public: pem(ec521.publicKey, 'spki'),
};
const signingKey = { HS: keys.hs, RS: keys.rsaPrivate, PS: keys.rsaPrivate, ES256: keys.ec256Private, ES384: keys.ec384Private, ES512: keys.ec521Private };
const verifyKey = { HS: keys.hs, RS: keys.rsaPublic, PS: keys.rsaPublic, ES256: keys.ec256Public, ES384: keys.ec384Public, ES512: keys.ec521Public };
const keyNameFor = (alg, side) => (alg.startsWith('ES') ? `${side === 'sign' ? 'ec' : 'ec'}${{ ES256: '256', ES384: '384', ES512: '521' }[alg]}${side === 'sign' ? 'Private' : 'Public'}` : alg.startsWith('HS') ? 'hs' : side === 'sign' ? 'rsaPrivate' : 'rsaPublic');
const kind = (alg) => (alg.startsWith('ES') ? alg : alg.slice(0, 2));

const NOW = 1_800_000_000;
const ALGS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384', 'ES512'];

// Signature : charges et options variées, l'heure fixée par iat.
const sign = [];
const expiries = [600, '15m', '1h', '2 days', '7d', '30s', '1.5h', 3600, '90'];
for (let i = 0; i < 120; i++) {
  const alg = ALGS[i % ALGS.length];
  const payload = { sub: `u${i}`, role: random.pick(['user', 'admin']), iat: NOW - random.int(0, 100), ...(random.chance(0.3) ? { email: `u${i}@example.test` } : {}) };
  const options = { algorithm: alg, expiresIn: random.pick(expiries), ...(random.chance(0.5) ? { issuer: 'auth.example.test' } : {}), ...(random.chance(0.5) ? { audience: random.chance(0.5) ? 'app.example.test' : ['app.example.test', 'other.example.test'] } : {}), ...(random.chance(0.2) ? { notBefore: 10 } : {}), ...(random.chance(0.2) ? { jwtid: `id-${i}` } : {}), ...(random.chance(0.2) ? { subject: `s${i}` } : {}) };
  delete (options.subject ? payload : {}).sub;
  sign.push({ id: `sign ${i} ${alg}`, alg, key: keyNameFor(alg, 'sign'), payload, options, token: jwt.sign(payload, signingKey[kind(alg)], options) });
}
// Options en double : la charge a déjà iss, et options.issuer est donné.
const signErrors = [];
for (const [name, payload, options] of [
  ['issuer twice', { iss: 'a' }, { issuer: 'b', algorithm: 'HS256' }],
  ['audience twice', { aud: 'a' }, { audience: 'b', algorithm: 'HS256' }],
  ['expiresIn with exp', { exp: NOW + 10 }, { expiresIn: 60, algorithm: 'HS256' }],
  ['unknown algorithm', {}, { algorithm: 'HS999' }],
  ['bad expiresIn', { iat: NOW }, { expiresIn: 'demain', algorithm: 'HS256' }],
]) {
  try { jwt.sign(payload, keys.hs, options); signErrors.push({ name, payload, options, error: null }); } catch (e) { signErrors.push({ name, payload, options, error: e.message }); }
}

// Vérification : un corpus de jetons, chacun avec ses options et l'heure, et la réponse de jsonwebtoken.
const verify = [];
const outcome = (token, alg, options) => {
  try {
    return { ok: jwt.verify(token, verifyKey[kind(alg)], options) };
  } catch (e) {
    return { error: e.name };
  }
};
const optionSets = [
  {},
  { issuer: 'auth.example.test' },
  { issuer: ['auth.example.test', 'other-issuer'] },
  { audience: 'app.example.test' },
  { audience: ['nope', 'app.example.test'] },
  { issuer: 'auth.example.test', audience: 'app.example.test' },
  { clockTolerance: 120 },
  { maxAge: '1h' },
  { maxAge: 30 },
];
const push = (id, token, alg, extra = {}, clock = NOW) => {
  const options = { algorithms: [alg], clockTimestamp: clock, ...extra };
  verify.push({ id, token, alg, key: keyNameFor(alg, 'verify'), options, expected: outcome(token, alg, options) });
};
for (const alg of ALGS) {
  const base = jwt.sign({ sub: 'u1', role: 'user', iat: NOW - 10 }, signingKey[kind(alg)], { algorithm: alg, expiresIn: 600, issuer: 'auth.example.test', audience: 'app.example.test' });
  for (const [i, opts] of optionSets.entries()) push(`${alg} base options ${i}`, base, alg, opts);
  push(`${alg} base, expired clock`, base, alg, {}, NOW + 1000);
  push(`${alg} base, exactly at exp`, base, alg, {}, NOW + 590);
  push(`${alg} base, one second before exp`, base, alg, {}, NOW + 589);
  push(`${alg} base, expired but within tolerance`, base, alg, { clockTolerance: 30 }, NOW + 600);
  push(`${alg} base, wrong algorithm list`, base, alg, { algorithms: [alg.startsWith('HS') ? 'RS256' : 'HS256'] });
  for (const attack of jwtAttacks(base, { publicKey: alg.startsWith('HS') ? undefined : crypto.createPublicKey(verifyKey[kind(alg)]) })) {
    if (attack.token.length > 20_000) continue;
    push(`${alg} attack: ${attack.name}`, attack.token, alg);
  }
}
for (const { name, payload } of jwtClaimAttacks({ sub: 'u1', iss: 'auth.example.test', aud: 'app.example.test' }, { audience: 'app.example.test', issuer: 'auth.example.test' })) {
  // Les revendications sont relatives à l'heure réelle : on les recale sur NOW.
  const shift = NOW - Math.floor(Date.now() / 1000);
  const fixed = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, ['exp', 'nbf', 'iat'].includes(k) && typeof v === 'number' ? v + shift : v]));
  const token = forgeJwt({ payload: fixed, secret: keys.hs });
  push(`claims: ${name}`, token, 'HS256', { issuer: 'auth.example.test', audience: 'app.example.test' });
  push(`claims: ${name} (no iss/aud check)`, token, 'HS256');
}
for (const [name, payload] of [
  ['nbf in the future', { sub: 'u', nbf: NOW + 100 }],
  ['nbf within tolerance', { sub: 'u', nbf: NOW + 5 }],
  ['nbf not a number', { sub: 'u', nbf: 'soon' }],
  ['exp null', { sub: 'u', exp: null }],
  ['no exp at all', { sub: 'u' }],
  ['aud array with the right one', { sub: 'u', aud: ['x', 'app.example.test'] }],
  ['aud number', { sub: 'u', aud: 42 }],
  ['iss array', { sub: 'u', iss: ['auth.example.test'] }],
  ['maxAge without iat', { sub: 'u' }],
  ['iat in the future', { sub: 'u', iat: NOW + 3600 }],
]) {
  const token = forgeJwt({ payload, secret: keys.hs });
  push(`edge: ${name}`, token, 'HS256');
  push(`edge: ${name} (aud)`, token, 'HS256', { audience: 'app.example.test' });
  push(`edge: ${name} (iss)`, token, 'HS256', { issuer: 'auth.example.test' });
  push(`edge: ${name} (maxAge)`, token, 'HS256', { maxAge: 60 });
  push(`edge: ${name} (tolerance)`, token, 'HS256', { clockTolerance: 10 });
}
const mutated = gen.mutated([jwt.sign({ sub: 'u1', iat: NOW }, keys.hs, { expiresIn: 600 })]);
for (let i = 0; i < 300; i++) push(`mutated ${i}`, mutated.generate(random.fork(`m${i}`)), 'HS256');

const out = { source: `jsonwebtoken ${require('jsonwebtoken/package.json').version}, recorded before it was replaced`, now: NOW, keys, sign, signErrors, verify };
fs.writeFileSync(path.join(__dirname, '..', '__tests__', 'fixtures', 'jwt-reference.json'), JSON.stringify(out) + '\n');
console.log(`${sign.length} signatures, ${signErrors.length} refus de signature, ${verify.length} vérifications enregistrées (${out.source}).`);
