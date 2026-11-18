'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  gen, compareImplementations, assertSameBehavior, runVectors, assertVectors, fromWycheproof, standardVectors,
  checkRelation, assertRelation, relations, transforms,
} = require('../security');

test('le différentiel voit une différence de réponse et une différence de refus', async () => {
  const reference = (s) => {
    if (typeof s !== 'string') throw new Error('refused');
    return s.trim().toLowerCase();
  };
  const candidate = (s) => String(s).trim().toLowerCase(); // ne refuse plus les non-textes
  const report = await compareImplementations({ reference, candidate, inputs: ['  A ', 'b', 42, null] });
  assert.equal(report.same, false);
  assert.equal(report.mismatches.length, 2);
  assert.equal(report.mismatches[0].input, 42);
  await assert.rejects(() => assertSameBehavior({ reference, candidate, inputs: [42], name: 'trim' }), /trim: 1 difference/);
});

test('le différentiel passe quand les deux répondent pareil, entrées tirées au hasard comprises', async () => {
  const reference = (s) => Buffer.from(s).toString('base64url');
  const candidate = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const report = await assertSameBehavior({ reference, candidate, generator: gen.string({ max: 64, alphabet: 'hostile' }), runs: 500 });
  assert.equal(report.compared, 500);
});

const hotp = ({ secret, counter, digits, algorithm }) => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
};

test('les vecteurs des RFC 4226 et 6238 : une implémentation correcte les passe tous', async () => {
  await assertVectors(standardVectors.hotpRfc4226, hotp, { source: 'RFC 4226' });
  const totp = ({ secret, time, step, digits, algorithm }) => hotp({ secret, counter: Math.floor(time / step), digits, algorithm });
  const report = await assertVectors(standardVectors.totpRfc6238, totp, { source: 'RFC 6238' });
  assert.equal(report.total, 18);
});

test('les vecteurs attrapent une implémentation fautive (troncature mal faite)', async () => {
  const wrong = (input) => hotp({ ...input }).replace(/^0/, '');
  const report = await runVectors(standardVectors.totpRfc6238, ({ secret, time, step, digits, algorithm }) => wrong({ secret, counter: Math.floor(time / step), digits, algorithm }));
  assert.equal(report.passed, false);
  await assert.rejects(() => assertVectors(standardVectors.hotpRfc4226, () => '000000', { source: 'RFC 4226' }), /10 of 10 vector\(s\) failed \(RFC 4226\)/);
});

test('le vecteur JWS de la RFC 7515 se vérifie avec sa clé', async () => {
  await assertVectors(standardVectors.jwsHs256Rfc7515, ({ token, jwk }) => {
    const [head, body, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', Buffer.from(jwk.k, 'base64url')).update(`${head}.${body}`).digest('base64url');
    return expected === signature;
  });
});

test('le format Wycheproof devient des vecteurs, « acceptable » admet les deux réponses', async () => {
  const file = { algorithm: 'ECDSA', testGroups: [{ key: { curve: 'secp256r1' }, tests: [{ tcId: 1, comment: 'valide', result: 'valid', msg: '00' }, { tcId: 2, comment: 'signature malléable', flags: ['Malleability'], result: 'invalid', msg: '01' }, { tcId: 3, result: 'acceptable', msg: '02' }] }] };
  const vectors = fromWycheproof(file);
  assert.equal(vectors.length, 3);
  assert.equal(vectors[1].comment, 'signature malléable, Malleability');
  assert.deepEqual(vectors[0].input.group, { key: { curve: 'secp256r1' } });
  const report = await runVectors(vectors, ({ msg }) => msg !== '01');
  assert.equal(report.passed, true);
  const lax = await runVectors(vectors, () => true);
  assert.equal(lax.failures.length, 1);
  assert.equal(lax.failures[0].vector.id, 'tcId 2');
});

test('métamorphique : une signature calculée sur le texte refuse le même JSON reformaté', async () => {
  const key = crypto.randomBytes(32);
  const sign = (text) => crypto.createHmac('sha256', key).update(text).digest('hex');
  const signed = (text) => ({ text, mac: sign(text) });
  const verify = ({ text, mac }) => sign(text) === mac;
  const inputs = [JSON.stringify({ a: 1, b: [1, 2], c: 'x' }), JSON.stringify({ z: true })];
  // On change le texte en gardant l'ancienne signature : le verdict doit être « refusé ».
  const report = await checkRelation({
    inputs: inputs.map(signed),
    transform: (value, random) => ({ text: transforms.reformatJson(value.text, random), mac: value.mac }),
    run: verify,
    relation: relations.changedRefused,
  });
  assert.equal(report.holds, true);
});

test('métamorphique : une recherche de compte qui ignore la casse et la forme Unicode est attrapée', async () => {
  const accounts = new Map([['élise@example.test', 'u1']]);
  const findNaive = (email) => accounts.get(email) ?? null;
  const report = await checkRelation({ inputs: ['élise@example.test'], transform: transforms.nfd, run: findNaive, relation: relations.same });
  assert.equal(report.holds, false);
  const findNormalized = (email) => accounts.get(String(email).normalize('NFC').toLowerCase()) ?? null;
  await assertRelation({ inputs: ['élise@example.test', 'ÉLISE@example.test'], transform: transforms.nfd, run: findNormalized, relation: relations.same });
});

test('les transformations font ce qu’elles disent', () => {
  const random = require('../security').createRandom(1);
  const reordered = transforms.reorderKeys({ a: 1, b: { c: 2, d: 3 }, e: [{ f: 1, g: 2 }] }, random);
  assert.deepEqual(reordered, { a: 1, b: { c: 2, d: 3 }, e: [{ f: 1, g: 2 }] });
  assert.notEqual(transforms.zeroWidth('admin', random), 'admin');
  assert.equal(transforms.zeroWidth('admin', random).replace(/[\u200B-\u200D\uFEFF]/g, ''), 'admin');
  const flipped = transforms.flipBit(Buffer.from('abc'), random);
  assert.equal(flipped.length, 3);
  assert.notDeepEqual(flipped, Buffer.from('abc'));
  assert.equal(relations.neverMorePermissive({ ok: false }, { ok: true }), false);
  assert.equal(relations.neverMorePermissive({ ok: true }, { ok: false }), true);
});
