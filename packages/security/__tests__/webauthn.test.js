jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(async () => ({ challenge: 'registration-challenge' })),
  verifyRegistrationResponse: jest.fn(async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: 'credential-1',
        publicKey: Buffer.from('public-key'),
        counter: 1,
        transports: ['internal']
      }
    }
  })),
  generateAuthenticationOptions: jest.fn(async () => ({ challenge: 'authentication-challenge' })),
  verifyAuthenticationResponse: jest.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 2 }
  }))
}));

const simpleWebauthn = require('@simplewebauthn/server');
const { createWebauthnService } = require('../src');

const createStore = () => ({
  credentials: [],
  challenges: [],
  recoveryHashes: new Set(),
  getCredentialsForUser: jest.fn(async (userId) => createStoreState.credentials.filter((credential) => credential.userId === userId)),
  saveCredential: jest.fn(async (userId, credential) => {
    createStoreState.credentials.push({ userId, ...credential });
  }),
  getCredentialById: jest.fn(async (credentialId) => createStoreState.credentials.find((credential) => credential.credentialID === credentialId)),
  updateCredentialCounter: jest.fn(async (credentialId, counter) => {
    const credential = createStoreState.credentials.find((item) => item.credentialID === credentialId);
    credential.counter = counter;
  }),
  saveChallenge: jest.fn(async (userId, challenge, purpose, metadata) => {
    createStoreState.challenges.push({ userId, challenge, purpose, metadata });
  }),
  consumeChallenge: jest.fn(async (userId, purpose) => {
    const index = createStoreState.challenges.findIndex((item) => item.userId === userId && item.purpose === purpose);
    return index === -1 ? null : createStoreState.challenges.splice(index, 1)[0];
  }),
  saveRecoveryCodes: jest.fn(async (userId, codeHashes) => {
    createStoreState.recoveryHashes.set(userId, new Set(codeHashes));
  }),
  consumeRecoveryCode: jest.fn(async (userId, codeHash) => {
    const hashes = createStoreState.recoveryHashes.get(userId);
    if (!hashes || !hashes.has(codeHash)) return false;
    hashes.delete(codeHash);
    return true;
  })
});

let createStoreState;

describe('webauthn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createStoreState = { credentials: [], challenges: [], recoveryHashes: new Map() };
    process.env.WEBAUTHN_ALLOWED_ORIGINS = 'https://app.example.com';
    delete process.env.CLIENT_URL;
  });

  test('starts registration with existing credentials excluded and saves challenge', async () => {
    const store = createStore();
    createStoreState.credentials.push({ userId: 'u1', credentialID: 'existing', transports: ['internal'] });
    const service = createWebauthnService(store, { rpName: 'Example' });

    const options = await service.getRegistrationOptions(
      { headers: { origin: 'https://app.example.com' } },
      'u1',
      'alice@example.com'
    );

    expect(options).toEqual({ challenge: 'registration-challenge' });
    expect(simpleWebauthn.generateRegistrationOptions).toHaveBeenCalledWith(expect.objectContaining({
      rpName: 'Example',
      rpID: 'app.example.com',
      userName: 'alice@example.com',
      excludeCredentials: [{ id: 'existing', transports: ['internal'] }]
    }));
    expect(store.saveChallenge).toHaveBeenCalledWith(
      'u1',
      'registration-challenge',
      'registration',
      expect.objectContaining({ rpID: 'app.example.com', origin: 'https://app.example.com' })
    );
  });

  test('verifies registration, saves credential, and generates recovery codes for first device', async () => {
    const store = createStore();
    const service = createWebauthnService(store, { recoveryCodeSecret: 'pepper' });
    await store.saveChallenge('u1', 'registration-challenge', 'registration', {
      origin: 'https://app.example.com',
      rpID: 'app.example.com'
    });

    const result = await service.verifyRegistration('u1', { response: true }, 'Laptop');

    expect(simpleWebauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: 'registration-challenge',
      expectedOrigin: 'https://app.example.com',
      expectedRPID: 'app.example.com'
    }));
    expect(store.saveCredential).toHaveBeenCalledWith('u1', expect.objectContaining({
      credentialID: 'credential-1',
      publicKey: expect.any(String),
      counter: 1,
      transports: ['internal'],
      deviceName: 'Laptop'
    }));
    expect(result.recoveryCodes).toHaveLength(10);
    expect(store.saveRecoveryCodes).toHaveBeenCalledWith('u1', expect.arrayContaining([expect.any(String)]));
  });

  test('starts authentication and verifies response while updating counter', async () => {
    const store = createStore();
    createStoreState.credentials.push({
      userId: 'u1',
      credentialID: 'credential-1',
      publicKey: Buffer.from('public-key').toString('base64url'),
      counter: 1,
      transports: ['internal']
    });
    const service = createWebauthnService(store);

    await service.getAuthenticationOptions({ headers: { origin: 'https://app.example.com' } }, 'u1');
    await service.verifyAuthentication('u1', { id: 'credential-1' });

    expect(simpleWebauthn.generateAuthenticationOptions).toHaveBeenCalledWith(expect.objectContaining({
      allowCredentials: [{ id: 'credential-1', transports: ['internal'] }]
    }));
    expect(simpleWebauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      credential: expect.objectContaining({ id: 'credential-1', counter: 1 })
    }));
    expect(store.updateCredentialCounter).toHaveBeenCalledWith('credential-1', 2);
  });

  test('rejects authentication when the credential belongs to another user', async () => {
    const store = createStore();
    createStoreState.credentials.push({
      userId: 'u2',
      credentialID: 'credential-2',
      publicKey: Buffer.from('public-key').toString('base64url'),
      counter: 1,
      transports: ['internal']
    });
    const service = createWebauthnService(store);
    await store.saveChallenge('u1', 'authentication-challenge', 'authentication', {
      origin: 'https://app.example.com',
      rpID: 'app.example.com'
    });

    await expect(service.verifyAuthentication('u1', { id: 'credential-2' }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(simpleWebauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  test('rejects expired authentication challenges', async () => {
    const store = createStore();
    createStoreState.credentials.push({
      userId: 'u1',
      credentialID: 'credential-1',
      publicKey: Buffer.from('public-key').toString('base64url'),
      counter: 1,
      transports: ['internal']
    });
    const service = createWebauthnService(store);
    await store.saveChallenge('u1', 'authentication-challenge', 'authentication', {
      origin: 'https://app.example.com',
      rpID: 'app.example.com',
      expiresAt: new Date(Date.now() - 1000)
    });

    await expect(service.verifyAuthentication('u1', { id: 'credential-1' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(simpleWebauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  test('rejects disallowed origins', async () => {
    const service = createWebauthnService(createStore());

    await expect(service.getRegistrationOptions(
      { headers: { origin: 'https://evil.example.com' } },
      'u1',
      'alice@example.com'
    )).rejects.toMatchObject({ statusCode: 403 });
  });

  test('generates and consumes recovery codes through the store', async () => {
    const store = createStore();
    const service = createWebauthnService(store, { recoveryCodeSecret: 'pepper' });

    const codes = await service.generateRecoveryCodes('u1');
    const firstUse = await service.verifyRecoveryCode('u1', codes[0]);
    const secondUse = await service.verifyRecoveryCode('u1', codes[0]);

    expect(codes).toHaveLength(10);
    expect(firstUse).toBe(true);
    expect(secondUse).toBe(false);
    expect(store.consumeRecoveryCode).toHaveBeenCalledWith('u1', expect.any(String));
  });
});

describe('createMemoryWebauthnStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WEBAUTHN_ALLOWED_ORIGINS = 'https://app.example.com';
    delete process.env.CLIENT_URL;
  });

  test('satisfies the full WebauthnStore contract through a real registration + authentication cycle', async () => {
    const { createMemoryWebauthnStore } = require('../src');
    const store = createMemoryWebauthnStore();
    const service = createWebauthnService(store, { rpName: 'Example', recoveryCodeSecret: 'pepper' });

    // Registration
    await service.getRegistrationOptions({ headers: { origin: 'https://app.example.com' } }, 'u1', 'alice@example.com');
    const registration = await service.verifyRegistration('u1', {}, 'MacBook');
    expect(registration.verified).toBe(true);
    expect(registration.isFirstDevice).toBe(true);
    expect(registration.recoveryCodes).toHaveLength(10);
    expect(await service.hasCredentials('u1')).toBe(true);

    // Authentication (before a second user registers — the mocked
    // verifyRegistrationResponse always returns the same fake credential
    // id, which would otherwise collide across users the way two real
    // WebAuthn ceremonies never would)
    await service.getAuthenticationOptions({ headers: { origin: 'https://app.example.com' } }, 'u1');
    const authenticated = await service.verifyAuthentication('u1', { id: 'credential-1' });
    expect(authenticated).toBe(true);

    // The counter update from verifyAuthentication (newCounter: 2, per the mock) persisted
    const [credential] = await store.getCredentialsForUser('u1');
    expect(credential.counter).toBe(2);

    // Challenges are one-time use
    await expect(service.verifyAuthentication('u1', { id: 'credential-1' })).rejects.toMatchObject({ statusCode: 400 });

    // Recovery codes: one-time use, scoped per user
    const firstUse = await service.verifyRecoveryCode('u1', registration.recoveryCodes[0]);
    const secondUse = await service.verifyRecoveryCode('u1', registration.recoveryCodes[0]);
    expect(firstUse).toBe(true);
    expect(secondUse).toBe(false);

    // A second user's credential list is independent of the first's
    await service.getRegistrationOptions({ headers: { origin: 'https://app.example.com' } }, 'u2', 'bob@example.com');
    await service.verifyRegistration('u2', {}, 'iPhone');
    const u1Credentials = await store.getCredentialsForUser('u1');
    expect(u1Credentials).toHaveLength(1);
    expect(await service.hasCredentials('u2')).toBe(true);
  });
});

describe('webauthn: what is refused', () => {
  const ORIGIN = { origin: 'https://app.example.com', rpID: 'app.example.com' };
  const credential = (userId, credentialID) => ({ userId, credentialID, publicKey: Buffer.from('public-key').toString('base64url'), counter: 1, transports: ['internal'] });

  beforeEach(() => {
    jest.clearAllMocks();
    createStoreState = { credentials: [], challenges: [], recoveryHashes: new Map() };
    process.env.WEBAUTHN_ALLOWED_ORIGINS = 'https://app.example.com';
    delete process.env.CLIENT_URL;
  });

  test('registration without a pending challenge is refused, and nothing is saved', async () => {
    const store = createStore();
    const service = createWebauthnService(store, { recoveryCodeSecret: 'pepper' });
    await expect(service.verifyRegistration('u1', { id: 'credential-1' })).rejects.toMatchObject({ statusCode: 400 });
    expect(simpleWebauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
    expect(store.saveCredential).not.toHaveBeenCalled();
  });

  test('a registration challenge serves once: replaying the same answer is refused', async () => {
    const store = createStore();
    const service = createWebauthnService(store, { recoveryCodeSecret: 'pepper' });
    await store.saveChallenge('u1', 'registration-challenge', 'registration', ORIGIN);
    await service.verifyRegistration('u1', { id: 'credential-1' });
    await expect(service.verifyRegistration('u1', { id: 'credential-1' })).rejects.toMatchObject({ statusCode: 400 });
    expect(store.saveCredential).toHaveBeenCalledTimes(1);
  });

  test('an expired registration challenge is refused before any verification', async () => {
    const store = createStore();
    const service = createWebauthnService(store, { recoveryCodeSecret: 'pepper' });
    await store.saveChallenge('u1', 'registration-challenge', 'registration', { ...ORIGIN, expiresAt: new Date(Date.now() - 1000) });
    await expect(service.verifyRegistration('u1', { id: 'credential-1' })).rejects.toMatchObject({ statusCode: 400 });
    expect(simpleWebauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  test('a registration the authenticator library does not verify saves no credential and gives no recovery codes', async () => {
    const store = createStore();
    const service = createWebauthnService(store, { recoveryCodeSecret: 'pepper' });
    simpleWebauthn.verifyRegistrationResponse.mockResolvedValueOnce({ verified: false });
    await store.saveChallenge('u1', 'registration-challenge', 'registration', ORIGIN);
    await expect(service.verifyRegistration('u1', { id: 'credential-1' })).rejects.toMatchObject({ statusCode: 400 });
    expect(store.saveCredential).not.toHaveBeenCalled();
    expect(store.saveRecoveryCodes).not.toHaveBeenCalled();
  });

  test('sign-in options are refused to an account with no passkey', async () => {
    const store = createStore();
    const service = createWebauthnService(store);
    await expect(service.getAuthenticationOptions({ headers: { origin: 'https://app.example.com' } }, 'u1')).rejects.toMatchObject({ statusCode: 400 });
    expect(store.saveChallenge).not.toHaveBeenCalled();
  });

  test('an unknown credential is a 401, never verified', async () => {
    const store = createStore();
    const service = createWebauthnService(store);
    await store.saveChallenge('u1', 'authentication-challenge', 'authentication', ORIGIN);
    await expect(service.verifyAuthentication('u1', { id: 'inconnue' })).rejects.toMatchObject({ statusCode: 401 });
    expect(simpleWebauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  test('a sign-in the library does not verify is a 401 and leaves the counter untouched', async () => {
    const store = createStore();
    createStoreState.credentials.push(credential('u1', 'credential-1'));
    const service = createWebauthnService(store);
    simpleWebauthn.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: false });
    await store.saveChallenge('u1', 'authentication-challenge', 'authentication', ORIGIN);
    await expect(service.verifyAuthentication('u1', { id: 'credential-1' })).rejects.toMatchObject({ statusCode: 401 });
    expect(store.updateCredentialCounter).not.toHaveBeenCalled();
  });

  test('a sign-in without a pending challenge is refused, and an authentication challenge does not open registration', async () => {
    const store = createStore();
    createStoreState.credentials.push(credential('u1', 'credential-1'));
    const service = createWebauthnService(store, { recoveryCodeSecret: 'pepper' });
    await expect(service.verifyAuthentication('u1', { id: 'credential-1' })).rejects.toMatchObject({ statusCode: 400 });
    await store.saveChallenge('u1', 'authentication-challenge', 'authentication', ORIGIN);
    await expect(service.verifyRegistration('u1', { id: 'credential-9' })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a recovery code is refused when wrong, for another account, or once used', async () => {
    const store = createStore();
    const service = createWebauthnService(store, { recoveryCodeSecret: 'pepper' });
    const codes = await service.generateRecoveryCodes('u1');
    expect(await service.verifyRecoveryCode('u1', '0000-0000')).toBe(false);
    expect(await service.verifyRecoveryCode('u2', codes[0])).toBe(false);
    expect(await service.verifyRecoveryCode('u1', codes[0])).toBe(true);
    expect(await service.verifyRecoveryCode('u1', codes[0])).toBe(false);
  });

  test('recovery codes refuse to work without a secret, or with a store that cannot keep them', async () => {
    const store = createStore();
    await expect(createWebauthnService(store).generateRecoveryCodes('u1')).rejects.toThrow(/recoveryCodeSecret/);
    await expect(createWebauthnService(store).verifyRecoveryCode('u1', 'abcd-ef01')).rejects.toThrow(/recoveryCodeSecret/);
    const withoutRecovery = { ...store, saveRecoveryCodes: undefined };
    await expect(createWebauthnService(withoutRecovery, { recoveryCodeSecret: 'pepper' }).generateRecoveryCodes('u1')).rejects.toThrow(/store\.saveRecoveryCodes/);
  });

  test('the service is not built on a store missing a method', () => {
    const store = createStore();
    expect(() => createWebauthnService(undefined)).toThrow(/createWebauthnService requires store\./);
    for (const method of ['getCredentialsForUser', 'saveCredential', 'getCredentialById', 'updateCredentialCounter', 'saveChallenge', 'consumeChallenge']) {
      expect(() => createWebauthnService({ ...store, [method]: undefined })).toThrow(`store.${method}`);
    }
  });
});
