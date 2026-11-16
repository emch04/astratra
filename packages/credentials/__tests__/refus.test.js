/* Ce que le coffre refuse : les cas qu'aucun autre test n'exerçait. */
const crypto = require('crypto');
const {
  createContextCipher, createReadChallenge, createMemoryReadChallengeStore,
  createUnlockChallenge, createMemoryChallengeStore,
  createCredentialVault, createCredentialCatalog, createMemoryVersionedCredentialStore
} = require('../src');

const context = { tenant: 'org', environment: 'production', name: 'KEY', version: 1 };
const value = ['private', 'fixture'].join('-');

describe('chiffrement à contexte', () => {
  const make = () => createContextCipher({ key: crypto.randomBytes(32) });

  test('une étiquette raccourcie est refusée, même faite des vrais octets', () => {
    const cipher = make();
    const parsed = JSON.parse(cipher.encrypt(value, context));
    const tag = Buffer.from(parsed.tag, 'base64');
    for (const length of [4, 8, 12, 15]) {
      const forged = JSON.stringify({ ...parsed, tag: tag.subarray(0, length).toString('base64') });
      expect(() => cipher.decrypt(forged, context)).toThrow('Credential decryption refused.');
    }
  });

  test('un nonce d’une autre longueur, un champ qui n’est pas du texte ou un base64 non canonique sont refusés', () => {
    const cipher = make();
    const parsed = JSON.parse(cipher.encrypt(value, context));
    const variants = [
      { ...parsed, iv: Buffer.alloc(16).toString('base64') },
      { ...parsed, iv: 123 },
      { ...parsed, tag: null },
      { ...parsed, data: ['x'] },
      { ...parsed, tag: parsed.tag.replace(/=+$/, '') }
    ];
    for (const variant of variants) {
      expect(() => cipher.decrypt(JSON.stringify(variant), context)).toThrow('Credential decryption refused.');
    }
  });
});

describe('défi de lecture', () => {
  const scope = { tenant: 'org', environment: 'production' };
  const vaultIn = (s) => ({ scope: s, get: jest.fn(async () => value) });

  test('un magasin qui plante au moment de consommer le défi donne un refus, jamais la valeur', async () => {
    const store = { ...createMemoryReadChallengeStore(), consume: async () => { throw new Error(value); } };
    const challenge = createReadChallenge({ store, verify: async () => true });
    const record = await challenge.request('owner', { scope, key: 'KEY' });
    const vault = vaultIn(scope);
    await expect(challenge.read('owner', record.id, null, vault)).rejects.toThrow('Credential read challenge refused.');
    expect(vault.get).not.toHaveBeenCalled();
  });

  test('un défi ouvert pour un espace ne lit pas dans un autre, ni sans coffre', async () => {
    for (const vault of [vaultIn({ ...scope, tenant: 'other' }), vaultIn(null), undefined]) {
      const challenge = createReadChallenge({ store: createMemoryReadChallengeStore(), verify: async () => true });
      const record = await challenge.request('owner', { scope, key: 'KEY' });
      await expect(challenge.read('owner', record.id, null, vault)).rejects.toThrow('refused');
      if (vault) expect(vault.get).not.toHaveBeenCalled();
    }
  });

  test('une demande sans clé ou avec une version invalide est refusée et rien n’est enregistré', async () => {
    const store = createMemoryReadChallengeStore();
    const save = jest.spyOn(store, 'save');
    const challenge = createReadChallenge({ store, verify: async () => true });
    for (const input of [{}, { key: '' }, { key: 'KEY', version: 0 }, { key: 'KEY', version: 1.5 }, { key: 'KEY', version: '2' }]) {
      await expect(challenge.request('owner', { scope, ...input })).rejects.toThrow('refused');
    }
    expect(save).not.toHaveBeenCalled();
  });

  test('un défi n’est pas construit sans magasin atomique, sans vérificateur ou avec une durée hors limites', () => {
    const store = createMemoryReadChallengeStore();
    expect(() => createReadChallenge({ verify: async () => true })).toThrow(/atomic store/);
    expect(() => createReadChallenge({ store })).toThrow(/verifier/);
    for (const ttlMs of [0, -1, 300_001, Infinity]) {
      expect(() => createReadChallenge({ store, verify: async () => true, ttlMs })).toThrow(/five minutes/);
    }
  });
});

describe('code de déverrouillage', () => {
  test('une fiche sans empreinte de code refuse tout code, même le bon format', async () => {
    const store = createMemoryChallengeStore();
    const challenge = createUnlockChallenge({ store, deliverCode: async () => {} });
    await store.save('owner', { codeHash: null, codeExpiresAt: new Date(Date.now() + 60_000), attempts: 0 });
    await expect(challenge.verifyCode('owner', '000000')).rejects.toMatchObject({ statusCode: 400 });
    expect(await challenge.unlockedUntil('owner')).toBeNull();
  });

  test('une empreinte enregistrée d’une autre longueur ne s’ouvre pas', async () => {
    const store = createMemoryChallengeStore();
    const challenge = createUnlockChallenge({ store, deliverCode: async () => {} });
    await store.save('owner', { codeHash: 'abc', codeExpiresAt: new Date(Date.now() + 60_000), attempts: 0 });
    await expect(challenge.verifyCode('owner', '123456')).rejects.toMatchObject({ statusCode: 400 });
    await expect(challenge.assertUnlocked('owner')).rejects.toMatchObject({ statusCode: 403 });
  });

  test('le déverrouillage n’est pas construit sans magasin ou sans moyen d’envoyer le code', () => {
    expect(() => createUnlockChallenge({ deliverCode: async () => {} })).toThrow(/options\.store/);
    expect(() => createUnlockChallenge({ store: createMemoryChallengeStore() })).toThrow(/deliverCode/);
  });
});

describe('historique du coffre', () => {
  const catalog = createCredentialCatalog({ spaces: [{ id: 'test', keys: [{ key: 'KEY' }] }] });
  const cipher = createContextCipher({ key: crypto.randomBytes(32) });
  const make = (options) => createCredentialVault({ catalog, cipher, env: {}, cacheMs: 0, fallback: 'none', ...options });

  test('lire une version sans historique activé, ou une version invalide, est une erreur', async () => {
    const sansHistorique = make({ store: createMemoryVersionedCredentialStore() });
    await expect(sansHistorique.get('KEY', { version: 1 })).rejects.toThrow('History is not enabled.');
    await expect(sansHistorique.listVersions('KEY')).rejects.toThrow('History is not enabled.');
    await expect(sansHistorique.purgeVersions()).rejects.toThrow('History is not enabled.');
    const vault = make({ store: createMemoryVersionedCredentialStore(), history: true });
    for (const version of [0, -1, 1.5, '1']) {
      await expect(vault.get('KEY', { version })).rejects.toThrow('Invalid version.');
    }
  });

  test('un magasin d’historique qui plante : rien en mode souple, une erreur sans la valeur en mode strict', async () => {
    const store = { ...createMemoryVersionedCredentialStore(), findVersion: async () => { throw new Error(value); } };
    const logger = { warn: jest.fn(), error: jest.fn() };
    expect(await make({ store, history: true, logger }).get('KEY', { version: 1 })).toBeNull();
    await expect(make({ store, history: true, strict: true, logger }).get('KEY', { version: 1 })).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNREADABLE' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(value);
  });

  test('une ancienne version illisible (chiffré abîmé) ne rend rien, ou une erreur en mode strict', async () => {
    const store = createMemoryVersionedCredentialStore();
    await make({ store, history: true }).set('KEY', value);
    const findVersion = store.findVersion.bind(store);
    store.findVersion = async (...args) => ({ ...(await findVersion(...args)), value: '{"v":1,"iv":"abîmé"}' });
    expect(await make({ store, history: true }).get('KEY', { version: 1 })).toBeNull();
    await expect(make({ store, history: true, strict: true }).get('KEY', { version: 1 })).rejects.toMatchObject({ code: 'CREDENTIAL_VALUE_UNREADABLE' });
  });

  test('l’écran d’état ne montre rien d’une ligne mal formée rendue par le magasin', async () => {
    const store = { ...createMemoryVersionedCredentialStore(), findAll: async () => [{ key: 'KEY', value: 42 }, null] };
    const status = await make({ store }).status();
    expect(status.spaces[0].keys[0].source).toBe('absent');
    await expect(make({ store, strict: true }).status()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNREADABLE' });
  });
});

describe('configurations refusées', () => {
  const { createCredentialRotation, createEnvHydrator, createCredentialsRoutes, createMemoryCredentialStore, maskSecret } = require('../src');
  const catalog = createCredentialCatalog({ spaces: [{ id: 'test', keys: [{ key: 'KEY' }] }] });
  const cipher = createContextCipher({ key: crypto.randomBytes(32) });

  test('un catalogue refuse une entrée sans clé et un espace sans identifiant', () => {
    for (const keys of [[{}], [{ key: '' }], [{ key: '   ' }], [null]]) {
      expect(() => createCredentialCatalog({ spaces: [{ id: 'test', keys }] })).toThrow(/non-empty key/);
    }
    for (const space of [{ keys: [] }, { id: '', keys: [] }, null]) {
      expect(() => createCredentialCatalog({ spaces: [space] })).toThrow(/space to have an id/);
    }
  });

  test('le coffre refuse un magasin incomplet, sans catalogue, sans chiffrement ou sans espaces quand on lui en donne un', () => {
    const store = createMemoryCredentialStore();
    expect(() => createCredentialVault({ store: { findAll() {} }, catalog, cipher })).toThrow(/options\.store\.upsert/);
    expect(() => createCredentialVault({ store, cipher })).toThrow(/options\.catalog/);
    expect(() => createCredentialVault({ store, catalog })).toThrow(/options\.cipher/);
    expect(() => createCredentialVault({ store, catalog, cipher: { encrypt() {} } })).toThrow(/options\.cipher/);
    expect(() => createCredentialVault({ store: { findAll() {}, upsert() {} }, catalog, cipher, scope: { tenant: 'org', environment: 'production' } })).toThrow(/credential scopes/);
  });

  test('la rotation refuse un magasin versionné, un magasin sans espaces ou sans catalogue', () => {
    const store = createMemoryCredentialStore();
    expect(() => createCredentialRotation({ store: createMemoryVersionedCredentialStore(), catalog, from: cipher, to: cipher })).toThrow(/versioned stores/);
    expect(() => createCredentialRotation({ store: { findAll() {}, upsert() {} }, scope: { tenant: 'org', environment: 'production' }, catalog })).toThrow(/credential scopes/);
    expect(() => createCredentialRotation({ store, from: cipher, to: cipher })).toThrow(/options\.catalog/);
  });

  test('ni les routes ni l’hydratation de l’environnement ne se construisent sans coffre', () => {
    expect(() => createCredentialsRoutes({})).toThrow(/options\.vault/);
    expect(() => createCredentialsRoutes({ vault: {} })).toThrow(/options\.vault/);
    expect(() => createEnvHydrator({})).toThrow(/options\.vault/);
    expect(() => createEnvHydrator({ vault: { status() {} } })).toThrow(/options\.vault/);
  });

  test('masquer une valeur absente ne rend rien, et une valeur courte ne montre aucun caractère', () => {
    for (const empty of [null, undefined, '']) expect(maskSecret(empty)).toBeNull();
    expect(maskSecret('abcd')).toBe('••••');
  });
});
