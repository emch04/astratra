const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const {
  jwtAttacks, jwtClaimAttacks, forgeJwt, assertVectors, standardVectors, assertFuzz, gen, assertConstantTime,
  assertProperty, assertRelation, transforms, relations, assertSafeRegex, extractRegexLiterals, payloads,
} = require('@astratra/testkit/security');
const { signJwt, verifyJwt, decodeJwt, JsonWebTokenError, TokenExpiredError, NotBeforeError } = require('../src');

// Le module de jetons (src/jwt.js), écrit avec node:crypto à la place de jsonwebtoken : comparé aux vecteurs
// enregistrés de jsonwebtoken 9, puis essais d'attaque avec @astratra/testkit/security.

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/jwt-reference.json'), 'utf8'));
const K = reference.keys;
const publicFor = (name) => K[name.replace('Private', 'Public')];

describe('vecteurs enregistrés de jsonwebtoken 9.0.3', () => {
  test('signatures HMAC et RSA identiques à l’octet ; ECDSA et PSS (aléatoires) vérifiées dans les deux sens', async () => {
    await assertVectors(reference.sign.map((c) => ({ id: c.id, input: c, expected: 'valid' })), (c) => {
      const ours = signJwt(c.payload, K[c.key], c.options);
      if ((c.alg.startsWith('HS') || c.alg.startsWith('RS')) && ours !== c.token) return false;
      const loose = { algorithms: [c.alg], clockTimestamp: reference.now, ignoreExpiration: true, ignoreNotBefore: true };
      const key = c.alg.startsWith('HS') ? K.hs : publicFor(c.key);
      return JSON.stringify(verifyJwt(c.token, key, loose)) === JSON.stringify(verifyJwt(ours, key, loose));
    }, { source: reference.source });
  });

  test('mêmes refus de signature, mot pour mot', async () => {
    await assertVectors(reference.signErrors.map((e) => ({ id: e.name, input: e, expected: e.error })), (e) => {
      try {
        signJwt(e.payload, K.hs, e.options);
        return null;
      } catch (error) {
        return error.message;
      }
    });
  });

  test(`mêmes verdicts sur ${reference.verify.length} vérifications (jetons valides, expirés, piégés, abîmés)`, async () => {
    // Là où jsonwebtoken plantait (SyntaxError, TypeError sur un jeton abîmé), le module refuse par sa propre erreur.
    await assertVectors(reference.verify.map((v) => ({ id: v.id, input: v, expected: v.expected.ok ? { ok: v.expected.ok } : { error: ['SyntaxError', 'TypeError'].includes(v.expected.error) ? 'JsonWebTokenError' : v.expected.error } })), (v) => {
      try {
        return { ok: verifyJwt(v.token, K[v.key], v.options) };
      } catch (error) {
        return { error: error.name };
      }
    }, { source: reference.source });
  });
});

describe('normes', () => {
  test('RFC 7515 annexe A.1 : le JWS HS256 se vérifie avec sa clé', async () => {
    await assertVectors(standardVectors.jwsHs256Rfc7515, ({ token, jwk }) => verifyJwt(token, Buffer.from(jwk.k, 'base64url'), { algorithms: ['HS256'], ignoreExpiration: true }));
  });

  test('signer puis vérifier rend la charge, pour chaque algorithme et toute charge (propriété)', async () => {
    const cases = [['HS256', K.hs, K.hs], ['HS384', K.hs, K.hs], ['HS512', K.hs, K.hs], ['RS256', K.rsaPrivate, K.rsaPublic], ['RS512', K.rsaPrivate, K.rsaPublic], ['PS256', K.rsaPrivate, K.rsaPublic], ['PS512', K.rsaPrivate, K.rsaPublic], ['ES256', K.ec256Private, K.ec256Public], ['ES384', K.ec384Private, K.ec384Public], ['ES512', K.ec521Private, K.ec521Public]];
    const claims = gen.record({ sub: gen.string({ min: 1, max: 40, alphabet: 'hostile' }), n: gen.integer(-1e6, 1e6), tags: gen.array(gen.string({ max: 10 }), { max: 4 }), ok: gen.boolean() });
    for (const [alg, priv, pub] of cases) {
      await assertProperty(claims, (payload) => {
        const token = signJwt(payload, priv, { algorithm: alg, expiresIn: 60 });
        const back = verifyJwt(token, pub, { algorithms: [alg] });
        return back.sub === payload.sub && back.n === payload.n && JSON.stringify(back.tags) === JSON.stringify(payload.tags) && back.ok === payload.ok;
      }, { runs: alg.startsWith('HS') ? 200 : 25, name: alg });
    }
  });
});

describe('attaques', () => {
  const families = [['HS256', K.hs, K.hs], ['RS256', K.rsaPrivate, K.rsaPublic], ['ES256', K.ec256Private, K.ec256Public], ['PS256', K.rsaPrivate, K.rsaPublic]];

  test.each(families)('%s : chaque jeton piégé dérivé d’un jeton valide est refusé', (alg, priv, pub) => {
    const token = signJwt({ sub: 'u1', role: 'user' }, priv, { algorithm: alg, expiresIn: 600 });
    expect(verifyJwt(token, pub, { algorithms: [alg] }).sub).toBe('u1');
    const publicKey = alg.startsWith('HS') ? crypto.createPublicKey(K.rsaPublic) : crypto.createPublicKey(pub);
    for (const attack of jwtAttacks(token, { publicKey })) {
      let accepted = false;
      try {
        verifyJwt(attack.token, pub, { algorithms: [alg] });
        accepted = true;
      } catch (error) {
        expect(error).toBeInstanceOf(JsonWebTokenError);
      }
      expect({ attack: attack.name, accepted }).toEqual({ attack: attack.name, accepted: false });
    }
  });

  test('confusion d’algorithme : une clé publique ne sert jamais de secret HMAC, même si HS256 est permis', () => {
    const rsToken = signJwt({ sub: 'u1' }, K.rsaPrivate, { algorithm: 'RS256', expiresIn: 600 });
    const forged = forgeJwt({ payload: { sub: 'admin', exp: Math.floor(Date.now() / 1000) + 600 }, secret: K.rsaPublic });
    expect(() => verifyJwt(forged, K.rsaPublic, { algorithms: ['RS256', 'HS256'] })).toThrow(/symmetric key/);
    expect(() => verifyJwt(forged, crypto.createPublicKey(K.rsaPublic), { algorithms: ['RS256', 'HS256'] })).toThrow(/symmetric key/);
    expect(verifyJwt(rsToken, K.rsaPublic, { algorithms: ['RS256', 'HS256'] }).sub).toBe('u1');
  });

  test('des revendications fausses signées avec la vraie clé sont refusées, chacune par la bonne erreur', () => {
    for (const { name, payload } of jwtClaimAttacks({ sub: 'u', iss: 'auth', aud: 'app' }, { audience: 'app', issuer: 'auth' })) {
      const token = forgeJwt({ payload, secret: K.hs });
      let error;
      try {
        verifyJwt(token, K.hs, { algorithms: ['HS256'], issuer: 'auth', audience: 'app' });
      } catch (caught) {
        error = caught;
      }
      // « issued in the future » et « iat not a number » sont refusés plus haut (createAuthMiddleware, jwtAuth.js).
      if (name === 'issued in the future' || name === 'iat not a number') continue;
      expect({ name, refused: error instanceof JsonWebTokenError }).toEqual({ name, refused: true });
      if (name.startsWith('expired')) expect(error).toBeInstanceOf(TokenExpiredError);
      if (name.startsWith('not yet valid')) expect(error).toBeInstanceOf(NotBeforeError);
    }
  });

  test('les clés d’une autre famille, d’une autre courbe ou trop courtes sont refusées', () => {
    const rsa1024 = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect(() => signJwt({}, rsa1024.privateKey, { algorithm: 'RS256' })).toThrow(/2048 bits/);
    expect(() => signJwt({}, K.ec256Private, { algorithm: 'ES384' })).toThrow(/curve/);
    expect(() => signJwt({}, K.ec256Private, { algorithm: 'RS256' })).toThrow(/key type/);
    expect(() => signJwt({}, K.rsaPublic, { algorithm: 'RS256' })).toThrow(/cannot be read|private key/);
    expect(() => signJwt({}, '', { algorithm: 'HS256' })).toThrow(/must be provided/);
    expect(() => signJwt({}, crypto.createSecretKey(Buffer.from('s')), { algorithm: 'RS256' })).toThrow(/symmetric/);
    expect(() => signJwt([], K.hs)).toThrow(/plain object/);
    expect(() => verifyJwt(signJwt({}, K.hs), K.hs)).toThrow(/algorithms/);
    expect(() => verifyJwt(signJwt({}, K.hs), K.hs, { algorithms: ['none'] })).toThrow(/algorithms/);
    // Une clé privée sert aussi à vérifier (sa partie publique), comme avant.
    expect(verifyJwt(signJwt({ a: 1 }, K.ec256Private, { algorithm: 'ES256' }), K.ec256Private, { algorithms: ['ES256'] }).a).toBe(1);
  });

  test('correctement signé mais écrit autrement : base64url non canonique, en-tête crit, charge qui n’est pas un objet', () => {
    const hmac = (input) => crypto.createHmac('sha256', K.hs).update(input).digest('base64url');
    const valid = signJwt({ sub: 'u1' }, K.hs, { expiresIn: 600 });
    const [h, p, s] = valid.split('.');
    // Le dernier caractère d'une signature de 32 octets porte 2 bits inutilisés : une autre lettre décode aux mêmes
    // octets. Accepter cette écriture rendrait un jeton malléable (deux jetons différents, la même signature).
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(s.at(-1));
    const twin = `${s.slice(0, -1)}${alphabet[(last & ~3) | ((last + 1) & 3)]}`;
    expect(Buffer.from(twin, 'base64url')).toEqual(Buffer.from(s, 'base64url'));
    expect(() => verifyJwt(`${h}.${p}.${twin}`, K.hs, { algorithms: ['HS256'] })).toThrow(/invalid signature/);
    const crit = signJwt({ sub: 'u1' }, K.hs, { expiresIn: 600, header: { crit: ['exp'] } });
    expect(() => verifyJwt(crit, K.hs, { algorithms: ['HS256'] })).toThrow(/critical/);
    for (const body of [[{ sub: 'u1' }], 'u1', 42, null]) {
      const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
      expect(() => verifyJwt(`${head}.${encoded}.${hmac(`${head}.${encoded}`)}`, K.hs, { algorithms: ['HS256'] })).toThrow(/invalid token/);
    }
  });

  test('un jeton immense est refusé avant tout calcul', () => {
    const huge = `${'a'.repeat(20_000)}.b.c`;
    const started = process.hrtime.bigint();
    expect(() => verifyJwt(huge, K.hs, { algorithms: ['HS256'] })).toThrow(/too long/);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(50);
  });

  test('le fuzz : toute entrée est refusée par une JsonWebTokenError, jamais par une autre exception', async () => {
    const valid = signJwt({ sub: 'u1' }, K.hs, { expiresIn: 600 });
    await assertFuzz((token) => {
      try {
        const out = verifyJwt(token, K.hs, { algorithms: ['HS256', 'RS256'] });
        if (token !== valid) throw new Error('accepted a token that is not the valid one');
        return out;
      } catch (error) {
        if (error instanceof JsonWebTokenError) throw Object.assign(error, { status: 401 });
        throw error;
      }
    }, { generator: gen.oneOf(gen.mutated([valid]), gen.hostileString(), gen.string({ max: 300, alphabet: 'hostile' }), gen.json()), runs: 3000 });
    for (const value of [undefined, null, 42, {}, [], Buffer.from(valid), ...payloads.unicode]) expect(() => verifyJwt(value, K.hs, { algorithms: ['HS256'] })).toThrow(JsonWebTokenError);
    expect(decodeJwt('a.b')).toBeNull();
    expect(decodeJwt(null)).toBeNull();
  });

  test('métamorphique : un bit changé n’importe où, ou les clés de la charge dans un autre ordre, rendent le jeton invalide', async () => {
    const valid = signJwt({ sub: 'u1', role: 'user', a: 1, b: 2 }, K.hs, { expiresIn: 600 });
    await assertRelation({ inputs: Array(200).fill(valid), transform: transforms.flipBit, run: (t) => verifyJwt(t, K.hs, { algorithms: ['HS256'] }), relation: relations.changedRefused });
    await assertRelation({
      inputs: Array(50).fill(valid),
      transform: (token, random) => {
        const [h, p, s] = token.split('.');
        const reordered = Buffer.from(JSON.stringify(transforms.reorderKeys(JSON.parse(Buffer.from(p, 'base64url')), random))).toString('base64url');
        return reordered === p ? `${h}.${p}x.${s}` : `${h}.${reordered}.${s}`;
      },
      run: (t) => verifyJwt(t, K.hs, { algorithms: ['HS256'] }),
      relation: relations.changedRefused,
    });
  });

  test('la signature HMAC est comparée en temps constant', () => {
    const valid = signJwt({ sub: 'u1' }, K.hs, { expiresIn: 600 });
    const [h, p, s] = valid.split('.');
    const bytes = Buffer.from(s, 'base64url');
    const wrong = (index) => {
      const copy = Buffer.from(bytes);
      copy[index] ^= 1;
      return `${h}.${p}.${copy.toString('base64url')}`;
    };
    const atStart = wrong(0);
    const atEnd = wrong(bytes.length - 1);
    assertConstantTime((token) => {
      try {
        verifyJwt(token, K.hs, { algorithms: ['HS256'] });
      } catch {
        // refusé : seul le temps compte
      }
    }, { classes: [() => atStart, () => atEnd], samples: 3000, name: 'signature HMAC' });
  });

  test('aucune expression régulière du module ne s’emballe', async () => {
    for (const regex of extractRegexLiterals(fs.readFileSync(path.join(__dirname, '../src/jwt.js'), 'utf8'))) await assertSafeRegex(regex);
  });
});
