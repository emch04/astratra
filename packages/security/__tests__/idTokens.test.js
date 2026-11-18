const crypto = require('crypto');
// Les jetons des essais viennent du module du paquet (jsonwebtoken retiré ; même forme de jeton, voir jwt.test.js).
const { signJwt, verifyJwt, decodeJwt } = require('../src');
const jwt = { sign: signJwt, verify: verifyJwt, decode: decodeJwt };
const {
  createIdTokenVerifier,
  createGoogleIdTokenVerifier,
  createAppleIdTokenVerifier,
  hashNonce,
  IdTokenError,
  GOOGLE_JWKS_URL,
  APPLE_JWKS_URL
} = require('../src/idTokens');

/* Un faux fournisseur : une paire RSA générée ici, son JWKS servi par un faux fetch. Jamais le vrai réseau. */
function fakeProvider({ issuer = 'https://issuer.test', kid = 'k1' } = {}) {
  let pairs = [{ kid, ...crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }) }];
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ keys: pairs.map((p) => ({ ...p.publicKey.export({ format: 'jwk' }), kid: p.kid, use: 'sig', alg: 'RS256' })) }) };
  };
  const sign = (claims, options = {}) => {
    const pair = pairs.find((p) => p.kid === (options.kid || pairs[0].kid)) || pairs[0];
    return jwt.sign({ iss: issuer, sub: 'sub-1', email: 'Person@Example.com', email_verified: true, ...claims }, options.key || pair.privateKey, {
      algorithm: 'RS256', keyid: options.kid || pair.kid, expiresIn: options.expiresIn || '10m', ...(options.noTimestamp ? { noTimestamp: true } : {})
    });
  };
  const rotate = (nextKid) => { pairs = [{ kid: nextKid, ...crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }) }]; };
  return { fetch, sign, rotate, calls, issuer };
}

const build = (provider, extra = {}) => createIdTokenVerifier({
  jwksUrl: 'https://issuer.test/keys', issuers: [provider.issuer], audiences: ['client-a', 'client-b'], fetch: provider.fetch, ...extra
});

describe('createIdTokenVerifier', () => {
  test('refuse une configuration incomplète', () => {
    expect(() => createIdTokenVerifier({ jwksUrl: 'x', issuers: ['i'], audiences: [] })).toThrow();
    expect(() => createIdTokenVerifier({ jwksUrl: '', issuers: ['i'], audiences: ['a'] })).toThrow();
    expect(() => createGoogleIdTokenVerifier({ audiences: [''] })).toThrow();
  });

  test('un jeton valide rend le sujet, l’adresse en minuscules et sa vérification', async () => {
    const p = fakeProvider();
    const verify = build(p);
    const profile = await verify(p.sign({ aud: 'client-b' }));
    expect(profile).toMatchObject({ subject: 'sub-1', email: 'person@example.com', emailVerified: true, relayEmail: false, audience: 'client-b' });
  });

  test('email_verified en texte (Apple) est compris ; absent, l’adresse n’est pas vérifiée', async () => {
    const p = fakeProvider();
    const verify = build(p);
    expect((await verify(p.sign({ aud: 'client-a', email_verified: 'true' }))).emailVerified).toBe(true);
    expect((await verify(p.sign({ aud: 'client-a', email_verified: undefined }))).emailVerified).toBe(false);
    expect((await verify(p.sign({ aud: 'client-a', email_verified: 'false' }))).emailVerified).toBe(false);
  });

  test('l’adresse relais d’Apple est signalée', async () => {
    const p = fakeProvider();
    const verify = build(p);
    expect((await verify(p.sign({ aud: 'client-a', email: 'abc@privaterelay.appleid.com', is_private_email: 'true' }))).relayEmail).toBe(true);
  });

  test.each([
    ['mauvaise audience', (p) => p.sign({ aud: 'other' }), 'invalid'],
    ['mauvais émetteur', (p) => p.sign({ aud: 'client-a', iss: 'https://evil.test' }), 'invalid'],
    ['expiré', (p) => p.sign({ aud: 'client-a' }, { expiresIn: '-1m' }), 'expired'],
    ['signé par une autre clé au même kid', (p) => p.sign({ aud: 'client-a' }, { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), 'invalid'],
    ['illisible', () => 'pas.un.jeton', 'malformed'],
    ['vide', () => '', 'malformed']
  ])('refuse un jeton %s', async (_name, make, code) => {
    const p = fakeProvider();
    await expect(build(p)(make(p))).rejects.toMatchObject({ name: 'IdTokenError', code });
  });

  test('refuse HS256 signé avec la clé publique et alg none', async () => {
    const p = fakeProvider();
    const verify = build(p);
    const hs = jwt.sign({ iss: p.issuer, aud: 'client-a', sub: 'x' }, 'secret', { algorithm: 'HS256', keyid: 'k1' });
    await expect(verify(hs)).rejects.toMatchObject({ code: 'malformed' });
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: p.issuer, aud: 'client-a', sub: 'x' })).toString('base64url')}.`;
    await expect(verify(none)).rejects.toMatchObject({ code: 'malformed' });
  });

  test('l’horloge injectée juge l’expiration', async () => {
    const p = fakeProvider();
    let t = Date.now();
    const verify = build(p, { now: () => t });
    const token = p.sign({ aud: 'client-a' }, { expiresIn: '5m' });
    await expect(verify(token)).resolves.toBeTruthy();
    t += 6 * 60 * 1000;
    await expect(verify(token)).rejects.toMatchObject({ code: 'expired' });
  });

  test('le nonce attendu doit être exactement celui du jeton', async () => {
    const p = fakeProvider();
    const verify = build(p);
    const raw = 'nonce-brut-123';
    const token = p.sign({ aud: 'client-a', nonce: hashNonce(raw) });
    await expect(verify(token, { nonce: hashNonce(raw) })).resolves.toBeTruthy();
    await expect(verify(token, { nonce: hashNonce('autre') })).rejects.toMatchObject({ code: 'nonce_mismatch' });
    await expect(verify(p.sign({ aud: 'client-a' }), { nonce: 'x' })).rejects.toMatchObject({ code: 'nonce_mismatch' });
    await expect(verify(token, { nonce: ['autre', hashNonce(raw)] })).resolves.toBeTruthy();
    await expect(verify(token, { nonce: [] })).rejects.toMatchObject({ code: 'nonce_mismatch' });
    expect(hashNonce('abc')).toBe(crypto.createHash('sha256').update('abc').digest('hex'));
  });

  test('un kid inconnu recharge les clés une seule fois par fenêtre', async () => {
    const p = fakeProvider();
    let t = 1_000_000;
    const verify = build(p, { now: () => t, minRefreshMs: 60_000 });
    await verify(p.sign({ aud: 'client-a' }, { noTimestamp: true, expiresIn: '1000d' }));
    expect(p.calls).toHaveLength(1);
    p.rotate('k2');
    t += 1000;
    const rotated = p.sign({ aud: 'client-a' }, { kid: 'k2', expiresIn: '1000d' });
    await expect(verify(rotated)).rejects.toMatchObject({ code: 'unknown_key' });
    await expect(verify(rotated)).rejects.toMatchObject({ code: 'unknown_key' });
    expect(p.calls).toHaveLength(1);
    t += 61_000;
    await expect(verify(rotated)).resolves.toMatchObject({ subject: 'sub-1' });
    expect(p.calls).toHaveLength(2);
  });

  test('deux vérifications simultanées partagent le même chargement', async () => {
    const p = fakeProvider();
    const verify = build(p);
    const token = p.sign({ aud: 'client-a' });
    await Promise.all([verify(token), verify(token), verify(token)]);
    expect(p.calls).toHaveLength(1);
  });

  test('un fournisseur injoignable donne keys_unavailable (503), sans le jeton dans le message', async () => {
    const p = fakeProvider();
    const verify = build(p, { fetch: async () => { throw new Error('réseau'); } });
    const token = p.sign({ aud: 'client-a' });
    const error = await verify(token).catch((e) => e);
    expect(error).toBeInstanceOf(IdTokenError);
    expect(error.code).toBe('keys_unavailable');
    expect(error.statusCode).toBe(503);
    expect(error.message).not.toContain(token);
  });

  test('Google et Apple visent leurs clés et émetteurs officiels', async () => {
    const google = fakeProvider({ issuer: 'https://accounts.google.com' });
    const verifyGoogle = createGoogleIdTokenVerifier({ audiences: ['g'], fetch: google.fetch });
    await expect(verifyGoogle(google.sign({ aud: 'g' }))).resolves.toBeTruthy();
    expect(google.calls[0]).toBe(GOOGLE_JWKS_URL);
    const apple = fakeProvider({ issuer: 'https://appleid.apple.com' });
    const verifyApple = createAppleIdTokenVerifier({ audiences: ['com.example.app'], fetch: apple.fetch });
    await expect(verifyApple(apple.sign({ aud: 'com.example.app' }))).resolves.toBeTruthy();
    expect(apple.calls[0]).toBe(APPLE_JWKS_URL);
    await expect(verifyApple(google.sign({ aud: 'com.example.app' }))).rejects.toBeInstanceOf(IdTokenError);
  });
});

describe('createIdTokenVerifier : ce qui est refusé', () => {
  const codeOf = (promise) => promise.then(() => 'ok', (e) => (e instanceof IdTokenError ? e.code : `autre : ${e.message}`));

  test('un jeton pour une autre application (audience) ou d’un autre émetteur est invalide', async () => {
    const p = fakeProvider();
    const verify = build(p);
    expect(await codeOf(verify(p.sign({ aud: 'client-pirate' })))).toBe('invalid');
    expect(await codeOf(verify(p.sign({ aud: 'client-a', iss: 'https://faux-emetteur.test' })))).toBe('invalid');
  });

  test('un jeton signé par une autre clé, sous le kid du fournisseur, est invalide', async () => {
    const p = fakeProvider();
    const verify = build(p);
    const intrus = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(await codeOf(verify(p.sign({ aud: 'client-a' }, { key: intrus.privateKey, kid: 'k1' })))).toBe('invalid');
  });

  test('un jeton sans sujet est invalide', async () => {
    const p = fakeProvider();
    const verify = build(p);
    expect(await codeOf(verify(p.sign({ aud: 'client-a', sub: '' })))).toBe('invalid');
  });

  test('un kid que le fournisseur ne publie pas donne unknown_key', async () => {
    const p = fakeProvider();
    const verify = build(p);
    const autre = fakeProvider({ issuer: p.issuer, kid: 'k-inconnu' });
    expect(await codeOf(verify(autre.sign({ aud: 'client-a' })))).toBe('unknown_key');
  });

  test('ce qui n’a pas la forme d’un jeton RS256 est malformé, avant tout appel au fournisseur', async () => {
    const p = fakeProvider();
    const verify = build(p);
    const rs512 = jwt.sign({ iss: p.issuer, sub: 's', aud: 'client-a' }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, { algorithm: 'RS512', keyid: 'k1' });
    const sansKid = jwt.sign({ iss: p.issuer, sub: 's', aud: 'client-a' }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, { algorithm: 'RS256' });
    for (const token of [undefined, '', 42, 'pas.un.jeton', 'a'.repeat(16 * 1024 + 1), rs512, sansKid]) {
      expect(await codeOf(verify(token))).toBe('malformed');
    }
    expect(p.calls).toHaveLength(0);
  });

  test('un fournisseur qui répond une erreur HTTP donne keys_unavailable', async () => {
    const p = fakeProvider();
    const verify = build(p, { fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    expect(await codeOf(verify(p.sign({ aud: 'client-a' })))).toBe('keys_unavailable');
  });

  test('les clés qui ne sont pas des clés RSA de signature sont ignorées', async () => {
    const p = fakeProvider();
    const jwks = (await (await p.fetch()).json()).keys;
    const verify = build(p, {
      fetch: async () => ({ ok: true, json: async () => ({ keys: [{ ...jwks[0], use: 'enc' }, { ...jwks[0], kty: 'EC' }] }) })
    });
    expect(await codeOf(verify(p.sign({ aud: 'client-a' })))).toBe('unknown_key');
    /* Une clé RSA sans rapport publiée sous le même kid ne valide rien. */
    const autre = build(p, { fetch: async () => ({ ok: true, json: async () => ({ keys: [{ kid: 'k1', kty: 'RSA', n: 'illisible', e: 'AQAB' }] }) }) });
    expect(await codeOf(autre(p.sign({ aud: 'client-a' })))).toBe('invalid');
  });

  test('sans fonction fetch, le vérificateur n’est pas construit', () => {
    expect(() => createIdTokenVerifier({ jwksUrl: 'https://issuer.test/keys', issuers: ['i'], audiences: ['a'], fetch: 'pas une fonction' })).toThrow(/fetch/);
  });
});
