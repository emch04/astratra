const crypto = require('node:crypto');
const { URLSearchParams } = require('node:url');
const jwt = require('jsonwebtoken');
const { assertNoSecrets, captureOutput, assertFuzz, gen, payloads, race, assertSameBehavior } = require('@astratra/testkit/security');
const { createGoogleServiceAccountAuth, signServiceAccountAssertion, readGoogleServiceAccount, isGoogleTokenUri, GoogleAuthError } = require('../src');

// Le jeton d'accès d'un compte de service Google, écrit sans google-auth-library : essais classiques, négatifs et
// d'attaque, avec @astratra/testkit/security.

const { privateKey: rsaKey, publicKey: rsaPublic } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = rsaKey.export({ type: 'pkcs8', format: 'pem' });
const ACCOUNT = { type: 'service_account', project_id: 'projet-essai', client_email: 'robot@projet-essai.iam.gserviceaccount.com', private_key: PEM, token_uri: 'https://oauth2.googleapis.com/token' };
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
const ACCESS_TOKEN = 'ya29.jeton-d-acces-tres-secret-0123456789';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Map(), json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

/** Un faux Google : l'échange du jeton et une API, avec la liste des appels. */
function fakeGoogle({ token = () => json(200, { access_token: ACCESS_TOKEN, expires_in: 3599 }), api = () => json(200, { ok: true }) } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') return token(init, calls);
    return api(url, init, calls);
  };
  return { fetch, calls, tokenCalls: () => calls.filter((c) => c.url.endsWith('/token')) };
}

describe('jeton de compte de service Google', () => {
  test('l’assertion est un JWT RS256 aux revendications exactes, vérifié par une autre implémentation (jsonwebtoken)', async () => {
    const google = fakeGoogle();
    const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE, 'https://www.googleapis.com/auth/cloud-platform'], fetch: google.fetch, now: () => 1_700_000_000_000 });
    expect(await auth.getAccessToken()).toBe(ACCESS_TOKEN);
    const form = new URLSearchParams(google.calls[0].init.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = jwt.verify(form.get('assertion'), rsaPublic.export({ type: 'spki', format: 'pem' }), { algorithms: ['RS256'], clockTimestamp: 1_700_000_000 });
    expect(claims).toEqual({ iss: ACCOUNT.client_email, scope: `${SCOPE} https://www.googleapis.com/auth/cloud-platform`, aud: 'https://oauth2.googleapis.com/token', iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(google.calls[0].init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(auth.clientEmail).toBe(ACCOUNT.client_email);
    expect(auth.projectId).toBe('projet-essai');
  });

  test('le compte à emprunter (sub) n’apparaît que si on le donne', () => {
    const account = readGoogleServiceAccount(ACCOUNT);
    const decode = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(decode(signServiceAccountAssertion(account, { scopes: [SCOPE], nowSeconds: 1 })).sub).toBeUndefined();
    expect(decode(signServiceAccountAssertion(account, { scopes: [SCOPE], subject: 'a@b.test', nowSeconds: 1 })).sub).toBe('a@b.test');
  });

  test('le jeton est gardé jusqu’à cinq minutes avant son échéance, puis renouvelé', async () => {
    let clock = 1_000_000;
    const google = fakeGoogle();
    const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: google.fetch, now: () => clock });
    await auth.getAccessToken();
    clock += 54 * 60 * 1000;
    await auth.getAccessToken();
    expect(google.tokenCalls()).toHaveLength(1);
    clock += 2 * 60 * 1000;
    await auth.getAccessToken();
    expect(google.tokenCalls()).toHaveLength(2);
    await auth.getAccessToken({ forceRefresh: true });
    expect(google.tokenCalls()).toHaveLength(3);
  });

  test('une durée annoncée immense est ramenée à une heure', async () => {
    let clock = 0;
    const google = fakeGoogle({ token: () => json(200, { access_token: ACCESS_TOKEN, expires_in: 10 ** 9 }) });
    const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: google.fetch, now: () => clock });
    await auth.getAccessToken();
    clock = 56 * 60 * 1000;
    await auth.getAccessToken();
    expect(google.tokenCalls()).toHaveLength(2);
  });

  test('50 demandes simultanées ne font qu’un seul échange', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const google = fakeGoogle({ token: async () => { await gate; return json(200, { access_token: ACCESS_TOKEN, expires_in: 3599 }); } });
    const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: google.fetch });
    const pending = race(() => auth.getAccessToken(), { concurrency: 50 });
    setImmediate(release);
    const result = await pending;
    expect(result.succeeded).toHaveLength(50);
    expect(google.tokenCalls()).toHaveLength(1);
  });

  test('request() envoie le JSON avec le jeton ; un 401 renouvelle le jeton et rejoue une seule fois', async () => {
    let tokens = 0;
    const google = fakeGoogle({
      token: () => json(200, { access_token: `jeton-${++tokens}`, expires_in: 3599 }),
      api: (url, init) => (init.headers.authorization === 'Bearer jeton-1' ? json(401, { error: 'expired' }) : json(200, { id: 'x', recu: JSON.parse(init.body) })),
    });
    const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: google.fetch });
    const response = await auth.request({ method: 'PATCH', url: 'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/1', data: { state: 'ACTIVE' } });
    expect(response).toEqual(expect.objectContaining({ status: 200, data: { id: 'x', recu: { state: 'ACTIVE' } } }));
    const apiCalls = google.calls.filter((c) => !c.url.endsWith('/token'));
    expect(apiCalls.map((c) => c.init.headers.authorization)).toEqual(['Bearer jeton-1', 'Bearer jeton-2']);
    expect(apiCalls[1].init.headers['content-type']).toBe('application/json');
  });

  test('une réponse d’erreur de l’API lève GOOGLE_API_ERROR avec response.status et response.data (comme avant)', async () => {
    const google = fakeGoogle({ api: () => json(404, { error: { message: 'introuvable' } }) });
    const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: google.fetch });
    const error = await auth.request({ url: 'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/1' }).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleAuthError);
    expect(error.code).toBe('GOOGLE_API_ERROR');
    expect(error.response).toEqual({ status: 404, data: { error: { message: 'introuvable' } } });
    await expect(auth.request({ url: 'http://walletobjects.googleapis.com/x' })).rejects.toMatchObject({ code: 'GOOGLE_URL_INVALID' });
  });
});

describe('refus', () => {
  const create = (credentials, extra = {}) => () => createGoogleServiceAccountAuth({ credentials, scopes: [SCOPE], fetch: async () => json(200, {}), ...extra });

  test.each([
    ['texte qui n’est pas du JSON', '{pas du json'],
    ['tableau', []],
    ['sans client_email', { ...ACCOUNT, client_email: undefined }],
    ['client_email sans @', { ...ACCOUNT, client_email: 'robot' }],
    ['client_email avec saut de ligne', { ...ACCOUNT, client_email: 'a@b\nc' }],
    ['clé qui n’est pas un PEM', { ...ACCOUNT, private_key: 'abc' }],
    ['PEM illisible', { ...ACCOUNT, private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }],
    ['clé EC au lieu de RSA', { ...ACCOUNT, private_key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }],
  ])('un compte de service mal formé est refusé : %s', (_name, credentials) => {
    expect(create(credentials)).toThrow(expect.objectContaining({ code: 'GOOGLE_CREDENTIALS_INVALID' }));
  });

  test('une clé collée avec des « \\n » écrits en toutes lettres est acceptée', () => {
    expect(create({ ...ACCOUNT, private_key: PEM.replace(/\n/g, '\\n') })).not.toThrow();
    expect(create(JSON.stringify(ACCOUNT))).not.toThrow();
  });

  test.each([
    'http://oauth2.googleapis.com/token',
    'https://oauth2.googleapis.com.evil.test/token',
    'https://evil.test/token',
    'https://oauth2.googleapis.com@evil.test/token',
    'https://user:pass@oauth2.googleapis.com/token',
    'https://oauth2.googleapis.com:8443/token',
    'https://googleapis.com.evil.test/',
    'https://evilgoogleapis.com/token',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://127.0.0.1/token',
    'not a url',
    ...payloads.ssrfUrls,
  ])('une adresse d’échange hors de Google est refusée (l’assertion signée n’y part jamais) : %s', (tokenUri) => {
    expect(create({ ...ACCOUNT, token_uri: tokenUri })).toThrow(expect.objectContaining({ code: 'GOOGLE_TOKEN_URI_REFUSED' }));
  });

  test('les adresses de Google passent, et allowedTokenUris en permet une autre (émulateur)', () => {
    expect(isGoogleTokenUri('https://oauth2.googleapis.com/token')).toBe(true);
    expect(isGoogleTokenUri('https://www.googleapis.com/oauth2/v4/token')).toBe(true);
    expect(create({ ...ACCOUNT, token_uri: undefined })).not.toThrow();
    expect(create({ ...ACCOUNT, token_uri: 'http://127.0.0.1:8089/token' }, { allowedTokenUris: ['http://127.0.0.1:8089/token'] })).not.toThrow();
  });

  test('des portées absentes ou qui ne sont pas des adresses https sont refusées', () => {
    for (const scopes of [undefined, [], ['wallet'], ['http://x'], [42]]) {
      expect(() => createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes, fetch: async () => json(200, {}) })).toThrow(expect.objectContaining({ code: 'GOOGLE_SCOPES_INVALID' }));
    }
  });

  test('un compte de service tiré au hasard ne fait jamais planter (seulement GoogleAuthError)', async () => {
    await assertFuzz((credentials) => {
      try {
        createGoogleServiceAccountAuth({ credentials, scopes: [SCOPE], fetch: async () => json(200, {}) });
      } catch (error) {
        if (error instanceof GoogleAuthError) throw Object.assign(error, { status: 400 });
        throw error;
      }
      return true;
    }, {
      generator: gen.oneOf(gen.json(), gen.hostileString(), gen.record({ client_email: gen.oneOf(gen.hostileString(), gen.constant(ACCOUNT.client_email)), private_key: gen.oneOf(gen.hostileString(), gen.constant(PEM), gen.mutated([PEM])), token_uri: gen.oneOf(gen.elements(payloads.ssrfUrls), gen.hostileString(), gen.constant(undefined)) })),
      runs: 600,
    });
  });
});

describe('pannes de Google, et aucun secret dans les erreurs ni les journaux', () => {
  const secrets = [ACCESS_TOKEN, PEM.split('\n')[1], PEM.split('\n')[5]];

  test('Google qui refuse le compte : GOOGLE_TOKEN_REFUSED avec le code OAuth, rien de plus', async () => {
    const google = fakeGoogle({ token: () => json(400, { error: 'invalid_grant', error_description: `clé ${PEM}` }) });
    const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: google.fetch });
    const { output, error } = await captureOutput(() => auth.getAccessToken());
    expect(error).toMatchObject({ code: 'GOOGLE_TOKEN_REFUSED', status: 401, httpStatus: 400 });
    expect(error.message).toBe('Google refused the service account (400: invalid_grant).');
    const assertion = new URLSearchParams(google.calls[0].init.body).get('assertion');
    assertNoSecrets(`${error.message}\n${error.stack}\n${output}`, { secrets: [...secrets, assertion] });
  });

  test('un code d’erreur OAuth piégé n’est pas recopié', async () => {
    const google = fakeGoogle({ token: () => json(400, { error: `<script>${'x'.repeat(100)}</script>` }) });
    const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: google.fetch });
    await expect(auth.getAccessToken()).rejects.toThrow(/^Google refused the service account \(400\)\.$/);
  });

  test('une réponse sans jeton est refusée', async () => {
    for (const body of [{}, { access_token: '' }, { access_token: 42 }, null]) {
      const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: fakeGoogle({ token: () => json(200, body) }).fetch });
      await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_REFUSED' });
    }
  });

  test('Google injoignable : GOOGLE_UNREACHABLE ; Google figé : abandon après le délai', async () => {
    const down = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: async () => { throw Object.assign(new Error(`ECONNREFUSED ${ACCESS_TOKEN}`), { code: 'ECONNREFUSED' }); } });
    const error = await down.getAccessToken().catch((e) => e);
    expect(error).toMatchObject({ code: 'GOOGLE_UNREACHABLE', status: 502 });
    assertNoSecrets(error.message, { secrets });
    const frozen = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], timeoutMs: 50, fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
    const started = Date.now();
    await expect(frozen.getAccessToken()).rejects.toMatchObject({ code: 'GOOGLE_UNREACHABLE', message: 'Google could not be reached (timed out).' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('une erreur de l’API ne recopie ni le jeton ni l’adresse complète', async () => {
    const google = fakeGoogle({ api: () => json(403, { error: { message: `refusé ${ACCESS_TOKEN}` } }) });
    const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: google.fetch });
    const error = await auth.request({ url: 'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/1?key=secret-dans-l-adresse' }).catch((e) => e);
    expect(error.message).toBe('Google API answered 403 for GET /walletobjects/v1/loyaltyObject/1.');
    assertNoSecrets(error.message, { secrets: [...secrets, 'secret-dans-l-adresse'] });
  });

  test('un échange qui échoue n’empêche pas le suivant (pas de promesse coincée)', async () => {
    let fail = true;
    const google = fakeGoogle({ token: () => (fail ? json(500, {}) : json(200, { access_token: ACCESS_TOKEN, expires_in: 3599 })) });
    const auth = createGoogleServiceAccountAuth({ credentials: ACCOUNT, scopes: [SCOPE], fetch: google.fetch });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_REFUSED', status: 502 });
    fail = false;
    expect(await auth.getAccessToken()).toBe(ACCESS_TOKEN);
  });
});

test('différentiel : la même assertion que la signature écrite à la main de wallet (signSaveJwt) pour les mêmes revendications', async () => {
  // Deux signatures RS256 indépendantes du même texte doivent coïncider (PKCS#1 v1.5 est déterministe).
  const account = readGoogleServiceAccount(ACCOUNT);
  await assertSameBehavior({
    reference: (nowSeconds) => {
      const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ iss: ACCOUNT.client_email, scope: SCOPE, aud: ACCOUNT.token_uri, iat: nowSeconds, exp: nowSeconds + 3600 })).toString('base64url');
      return `${head}.${body}.${crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PEM, 'base64url')}`;
    },
    candidate: (nowSeconds) => signServiceAccountAssertion(account, { scopes: [SCOPE], nowSeconds }),
    generator: gen.integer(0, 2_000_000_000),
    runs: 50,
  });
});
