/* Ce que la plomberie mobile refuse : les cas qu'aucun autre test n'exerçait. */
const {
  createBiometricGate, createWebKeystore, createApiClient, ApiError, readDataAddress,
  readPermission, createPushService, createConnectivityMonitor, createPushSettingsController
} = require('../src');

const authenticator = (overrides = {}) => ({
  hasHardwareAsync: async () => true,
  isEnrolledAsync: async () => true,
  authenticateAsync: jest.fn(async () => ({ success: true })),
  ...overrides
});
const memoryKeystore = (values = {}) => ({
  getItemAsync: async (k) => (k in values ? values[k] : null),
  setItemAsync: async (k, v) => { values[k] = v; },
  deleteItemAsync: async (k) => { delete values[k]; }
});

describe('verrou biométrique', () => {
  test('un trousseau qui plante vaut « désactivé », et Face ID n’est jamais demandé', async () => {
    const auth = authenticator();
    const gate = createBiometricGate({ keystore: { getItemAsync: async () => { throw new Error('trousseau verrouillé'); } }, authenticator: auth });
    expect((await gate.read()).enabled).toBe(false);
    expect(await gate.confirm()).toBe(false);
    expect(auth.authenticateAsync).not.toHaveBeenCalled();
  });

  const KEY = 'app.biometric.enabled';

  test('témoin : avec le drapeau exact « true », Face ID est bien demandé', async () => {
    const auth = authenticator();
    const gate = createBiometricGate({ keystore: memoryKeystore({ [KEY]: 'true' }), authenticator: auth });
    expect(gate.key).toBe(KEY);
    expect(await gate.confirm()).toBe(true);
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
  });

  test('seul le drapeau exact « true » active le verrou', async () => {
    for (const flag of ['TRUE', '1', 'yes', 'true ', true]) {
      const auth = authenticator();
      const gate = createBiometricGate({ keystore: memoryKeystore({ [KEY]: flag }), authenticator: auth });
      expect((await gate.read()).enabled).toBe(false);
      expect(await gate.confirm()).toBe(false);
      expect(auth.authenticateAsync).not.toHaveBeenCalled();
    }
  });

  test('un capteur qui plante pendant la confirmation vaut un refus', async () => {
    const gate = createBiometricGate({
      keystore: memoryKeystore({ [KEY]: 'true' }),
      authenticator: authenticator({ authenticateAsync: async () => { throw new Error('capteur'); } })
    });
    expect(await gate.confirm()).toBe(false);
  });

  test('une réponse du capteur sans succès explicite vaut un refus', async () => {
    for (const result of [null, undefined, {}, { success: false }]) {
      const gate = createBiometricGate({ keystore: memoryKeystore({ [KEY]: 'true' }), authenticator: authenticator({ authenticateAsync: async () => result }) });
      expect(await gate.confirm()).toBe(false);
    }
  });

  test('le verrou n’est pas construit sans trousseau ni authentificateur', () => {
    expect(() => createBiometricGate({ authenticator: authenticator() })).toThrow(/options\.keystore/);
    expect(() => createBiometricGate({ keystore: memoryKeystore() })).toThrow(/options\.authenticator/);
    expect(() => createBiometricGate({ keystore: memoryKeystore(), authenticator: {} })).toThrow(/authenticateAsync/);
  });
});

describe('trousseau web', () => {
  test('un stockage qui plante (navigation privée) rend null au lieu de faire tomber l’app', async () => {
    const keystore = createWebKeystore({ getItem: () => { throw new Error('SecurityError'); }, setItem() {}, removeItem() {} });
    expect(await keystore.getItemAsync('app.token')).toBeNull();
  });
});

describe('client d’API', () => {
  const session = { getAccessToken: async () => 'jeton', getRefreshToken: async () => null, setTokens: async () => {}, clear: async () => {} };
  const reponse = (status) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}), body: 'octets' });

  test('un flux ou des octets en erreur lèvent une ApiError avec le statut, sans rien rendre', async () => {
    for (const status of [400, 403, 404, 500]) {
      const api = createApiClient({ baseUrl: 'https://api.example.test/api', session, fetch: async () => reponse(status) });
      await expect(api.stream('/flux')).rejects.toMatchObject({ status, message: 'REQUEST_FAILED' });
      await expect(api.raw('/fichier')).rejects.toBeInstanceOf(ApiError);
    }
  });

  test('sans fetch disponible, le client n’est pas construit', () => {
    const original = globalThis.fetch;
    try {
      delete globalThis.fetch;
      expect(() => createApiClient({ baseUrl: 'https://api.example.test/api', session })).toThrow(/fetch implementation/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('adresses data:', () => {
  test('ce qui n’est pas une adresse data: bien formée est refusé', () => {
    for (const address of [undefined, 42, '', 'http://exemple.test/a.png', 'javascript:alert(1)', 'data', 'data:image/png;base64']) {
      expect(readDataAddress(address)).toEqual({ ok: false, reason: 'data_malformed' });
    }
  });
});

describe('permission des notifications', () => {
  const notifications = { IosAuthorizationStatus: { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 } };
  test('un refus iOS reste un refus, même si le champ commun dit autre chose', () => {
    expect(readPermission({ ios: { status: 1 }, granted: true, status: 'granted' }, notifications)).toBe('denied');
  });
  test('une réponse vide ou inconnue vaut un refus', () => {
    for (const status of [null, undefined, {}, { status: 'peut-être' }, { granted: false }]) {
      expect(readPermission(status, notifications)).toBe('denied');
    }
  });
});

describe('configurations refusées', () => {
  test('push, connectivité et réglages refusent ce dont ils ont besoin pour fonctionner', async () => {
    expect(() => createPushService({})).toThrow(/options\.load/);
    expect(() => createPushSettingsController({})).toThrow(/getState/);
    expect(() => createPushSettingsController(null)).toThrow(/getState/);
    await expect(createConnectivityMonitor({}).refresh()).rejects.toThrow(/netInfo adapter/);
  });
});
