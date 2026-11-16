const { createMemoryRevocationStore } = require('../src');

describe('revocation', () => {
  test('reports a revoked token id as revoked until it expires', async () => {
    const store = createMemoryRevocationStore();

    await store.revoke('token-1', Date.now() + 60_000);

    await expect(store.isRevoked('token-1')).resolves.toBe(true);
  });

  test('reports a token id that was never revoked as active', async () => {
    const store = createMemoryRevocationStore();

    await expect(store.isRevoked('token-2')).resolves.toBe(false);
  });

  test('purges expired token ids lazily', async () => {
    const store = createMemoryRevocationStore();

    await store.revoke('token-3', Date.now() - 1);

    await expect(store.isRevoked('token-3')).resolves.toBe(false);
  });

  test('reports user tokens issued before logout-all as revoked', async () => {
    const store = createMemoryRevocationStore();

    await store.revokeAllForUser('user-1', 2_000);

    await expect(store.isRevokedForUser('user-1', 1)).resolves.toBe(true);
  });

  test('reports user tokens issued after logout-all as active', async () => {
    const store = createMemoryRevocationStore();

    await store.revokeAllForUser('user-1', 2_000);

    await expect(store.isRevokedForUser('user-1', 3)).resolves.toBe(false);
  });

  test('reports tokens for users without logout-all as active', async () => {
    const store = createMemoryRevocationStore();

    await expect(store.isRevokedForUser('user-never-revoked', 1)).resolves.toBe(false);
  });
});

describe('revocation: what never counts as revoked or revoking', () => {
  test('an empty token id is never revoked, and revoking it changes nothing', async () => {
    const store = createMemoryRevocationStore();
    await store.revoke('', Date.now() + 60_000);
    await store.revoke(undefined, Date.now() + 60_000);
    expect(await store.isRevoked('')).toBe(false);
    expect(await store.isRevoked(undefined)).toBe(false);
  });

  test('logout-all without a user id revokes nobody', async () => {
    const store = createMemoryRevocationStore();
    await store.revokeAllForUser('');
    expect(await store.isRevokedForUser('', 1)).toBe(false);
    expect(await store.isRevokedForUser(undefined, 1)).toBe(false);
  });

  test('after logout-all, a token without a readable issue time is revoked: nothing proves it is newer', async () => {
    const store = createMemoryRevocationStore();
    await store.revokeAllForUser('user-1', Date.now());
    expect(await store.isRevokedForUser('user-1', 'hier')).toBe(true);
    expect(await store.isRevokedForUser('user-1', undefined)).toBe(true);
    /* A user who never logged out everywhere is not affected. */
    expect(await store.isRevokedForUser('user-2', undefined)).toBe(false);
  });
});
