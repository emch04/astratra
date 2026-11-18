const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { standardVectors, assertVectors, assertProperty, gen, assertFuzz, assertConstantTime, assertSafeRegex, extractRegexLiterals } = require('@astratra/testkit/security');
const { generateTotpSecret, totp, hotp, verifyTotp, totpUri, base32Encode, base32Decode, TotpError } = require('../src');

// La double authentification par code (src/totp.js), à la place d'otplib : vecteurs des RFC, réponses enregistrées
// d'otplib 13, puis essais d'attaque avec @astratra/testkit/security.

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/otp-reference.json'), 'utf8'));

describe('normes', () => {
  test('RFC 4226 (HOTP) et RFC 6238 (TOTP, SHA-1, SHA-256, SHA-512, huit chiffres)', async () => {
    await assertVectors(standardVectors.hotpRfc4226, ({ secret, counter, digits, algorithm }) => hotp(secret, counter, { digits, algorithm }), { source: 'RFC 4226' });
    await assertVectors(standardVectors.totpRfc6238, ({ secret, time, step, digits, algorithm }) => totp(secret, { epoch: time, period: step, digits, algorithm }), { source: 'RFC 6238' });
  });

  test('base32 (RFC 4648) : les exemples de la norme, et l’aller-retour pour tout octet (propriété)', async () => {
    const examples = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
    for (const [text, encoded] of examples) {
      expect(base32Encode(Buffer.from(text))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(text);
    }
    expect(base32Decode('mzxw 6ytb-oi======').toString()).toBe('foobar');
    await assertProperty(gen.bytes({ max: 200 }), (bytes) => base32Decode(base32Encode(bytes)).equals(bytes), { runs: 500 });
    for (const bad of ['MZXW1', 'MZXW8', 'MZ!W', 'é', '0', 'Z'.repeat(2000)]) expect(() => base32Decode(bad)).toThrow(TotpError);
  });
});

describe(`comparé à ${reference.source}`, () => {
  test(`mêmes ${reference.generateCases.length} codes`, async () => {
    await assertVectors(reference.generateCases.map((c) => ({ id: `${c.secret} @${c.epoch}`, input: c, expected: c.token })), (c) => totp(c.secret, { epoch: c.epoch }));
  });

  test(`mêmes ${reference.verifyCases.length} vérifications (fenêtre et décalage) ; un code mal formé est invalide au lieu de lever`, async () => {
    await assertVectors(reference.verifyCases.map((c) => ({ id: `${c.token} décalage ${c.offset} tolérance ${c.epochTolerance}`, input: c, expected: c.expected.error ? { valid: false } : c.expected.valid ? { valid: true, delta: c.expected.delta } : { valid: false } })), (c) => {
      const r = verifyTotp({ secret: c.secret, token: c.token, epoch: c.epoch, epochTolerance: c.epochTolerance });
      return r.valid ? { valid: true, delta: r.delta } : { valid: false };
    });
  });

  test('mêmes adresses otpauth:// ; un émetteur avec « : » est refusé (otplib rendait une adresse ambiguë)', () => {
    for (const c of reference.uriCases) {
      if (c.issuer.includes(':')) expect(() => totpUri(c)).toThrow(/must not contain/);
      else expect(totpUri(c)).toBe(c.uri);
    }
    expect(totpUri({ issuer: 'App', label: 'a@b.test', secret: reference.uriCases[0].secret, digits: 8, period: 60, algorithm: 'sha256' })).toMatch(/&algorithm=SHA256&digits=8&period=60$/);
  });

  test('un secret neuf a la forme de ceux d’otplib (32 caractères base32, 160 bits), et ne se répète pas', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(200);
    for (const s of secrets) expect(s).toMatch(new RegExp(`^[A-Z2-7]{${reference.generatedSecretLength}}$`));
  });
});

describe('vérification', () => {
  const secret = generateTotpSecret();
  const epoch = 1_800_000_015;

  test('un code déjà servi est refusé (afterStep), le suivant passe', () => {
    const code = totp(secret, { epoch });
    const first = verifyTotp({ secret, token: code, epoch });
    expect(first).toEqual(expect.objectContaining({ valid: true, delta: 0 }));
    expect(verifyTotp({ secret, token: code, epoch: epoch + 5, afterStep: first.timeStep })).toEqual({ valid: false, reason: 'replay', timeStep: first.timeStep });
    // Le code du pas précédent, encore dans la fenêtre, est aussi refusé une fois un pas plus récent servi.
    const previous = totp(secret, { epoch: epoch - 30 });
    expect(verifyTotp({ secret, token: previous, epoch, afterStep: first.timeStep }).valid).toBe(false);
    const next = totp(secret, { epoch: epoch + 30 });
    expect(verifyTotp({ secret, token: next, epoch: epoch + 30, afterStep: first.timeStep }).valid).toBe(true);
  });

  test('hors de la fenêtre : refusé ; tolérance zéro : seulement le pas courant', () => {
    expect(verifyTotp({ secret, token: totp(secret, { epoch: epoch - 90 }), epoch }).valid).toBe(false);
    expect(verifyTotp({ secret, token: totp(secret, { epoch: epoch + 60 }), epoch }).valid).toBe(false);
    expect(verifyTotp({ secret, token: totp(secret, { epoch: epoch - 30 }), epoch, epochTolerance: 0 }).valid).toBe(false);
    expect(() => verifyTotp({ secret, token: '000000', epoch, epochTolerance: 10_000 })).toThrow(/epochTolerance/);
  });

  test('codes mal formés : invalides, sans exception', () => {
    for (const token of ['', '12345', '1234567', 'abcdef', ' 123456', '123456 ', '１２３４５６', '12345\u0000', null, undefined, 123456, ['123456']]) {
      expect(verifyTotp({ secret, token, epoch })).toEqual({ valid: false, reason: 'format' });
    }
  });

  test('secrets et options refusés clairement', () => {
    expect(() => verifyTotp({ secret: 'AAAA', token: '123456' })).toThrow(/80 bits/);
    expect(() => verifyTotp({ secret: 'pas du base32 !', token: '123456' })).toThrow(/base32/);
    expect(() => totp(secret, { digits: 4 })).toThrow(/digits/);
    expect(() => totp(secret, { algorithm: 'md5' })).toThrow(/algorithm/);
    expect(() => hotp(secret, -1)).toThrow(/counter/);
    expect(() => generateTotpSecret({ bytes: 4 })).toThrow(/bytes/);
    expect(() => totpUri({ issuer: '', label: 'x', secret })).toThrow(/issuer/);
    expect(() => totpUri({ issuer: 'App', label: 'a:b', secret })).toThrow(/label/);
  });
});

describe('attaques', () => {
  const secret = generateTotpSecret();
  const epoch = 1_800_000_015;

  test('la comparaison ne dépend pas du chiffre faux (temps constant)', () => {
    const good = totp(secret, { epoch });
    const wrongFirst = `${(Number(good[0]) + 1) % 10}${good.slice(1)}`;
    const wrongLast = `${good.slice(0, 5)}${(Number(good[5]) + 1) % 10}`;
    assertConstantTime((token) => verifyTotp({ secret, token, epoch }), { classes: [() => wrongFirst, () => wrongLast], samples: 2000, name: 'TOTP' });
  });

  test('un vrai code reconnu au premier ou au dernier pas de la fenêtre prend le même temps', () => {
    const early = totp(secret, { epoch: epoch - 30 });
    const late = totp(secret, { epoch: epoch + 30 });
    assertConstantTime((token) => verifyTotp({ secret, token, epoch }), { classes: [() => early, () => late], samples: 2000, name: 'pas reconnu' });
  });

  test('le fuzz : un code ou un secret quelconque donne une réponse ou une TotpError, jamais un plantage', async () => {
    await assertFuzz((token) => verifyTotp({ secret, token, epoch }), { generator: gen.oneOf(gen.hostileString(), gen.string({ max: 12, alphabet: '0123456789 -' }), gen.json()), runs: 2000, check: (r) => r.valid === false || `accepted ${JSON.stringify(r)}` });
    await assertFuzz((s) => {
      try {
        return verifyTotp({ secret: s, token: '123456', epoch });
      } catch (error) {
        if (error instanceof TotpError) throw Object.assign(error, { status: 400 });
        throw error;
      }
    }, { generator: gen.oneOf(gen.hostileString(), gen.string({ max: 80, alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=- ' })), runs: 1000 });
  });

  test('deviner au hasard : sur 20 000 essais dans une fenêtre de trois pas, autour de 60 réussites (3 sur 1 000 000 par essai)', () => {
    // La sécurité vient de la limite d'essais de la route : sans elle, un million d'essais trouvent le code.
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (verifyTotp({ secret, token: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), epoch }).valid) hits += 1;
    expect(hits).toBeLessThan(5);
  });

  test('aucune expression régulière du module ne s’emballe', async () => {
    for (const regex of extractRegexLiterals(fs.readFileSync(path.join(__dirname, '../src/totp.js'), 'utf8'))) await assertSafeRegex(regex);
  });
});
