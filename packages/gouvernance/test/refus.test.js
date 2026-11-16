'use strict';
/* Ce que la gouvernance refuse : les cas qu'aucun autre test n'exerçait. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createTrust, signValidation, createMemoryGovernanceStore, createMemoryConnector } = require('../src');
const { makeGovernance, proposalInput, makeSigningKey, RESOURCES, DATA } = require('./helpers');

const filter = (where) => proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where, set: { stock: 1 } }] });

test('un filtre dont la valeur ne convient pas à l’opérateur est refusé avant tout aperçu', async () => {
  const { governance, shop } = makeGovernance();
  const before = JSON.stringify(shop.snapshot('products'));
  for (const where of [
    { promo: { isNull: 'oui' } },
    { promo: { isNull: 1 } },
    { category: { gt: { $ne: 1 } } },
    { category: { gte: null } },
    { category: { lt: true } },
    { category: { lte: false } },
    { category: { eq: ['kitchen'] } },
    { category: { in: [] } },
    { category: { in: [null] } },
    { category: { in: [{ $gt: '' }] } }
  ]) {
    await assert.rejects(governance.propose(filter(where)), { code: 'invalid_action' }, JSON.stringify(where));
  }
  assert.equal(JSON.stringify(shop.snapshot('products')), before);
});

test('une clé du service de validation illisible ou d’un autre type rend la confiance invalide', () => {
  const approvers = [];
  for (const publicKey of ['pas-une-cle', Buffer.from('rien').toString('base64'), '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----', '', undefined]) {
    assert.throws(() => createTrust({ keys: [{ keyId: 'key-1', publicKey }], approvers, rpId: 'x.example', origins: ['https://x.example'] }), { code: 'invalid_trust' });
  }
  const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => createTrust({ keys: [{ keyId: 'key-1', publicKey: p256 }], approvers, rpId: 'x.example', origins: ['https://x.example'] }), { code: 'invalid_trust' });
  const privee = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => createTrust({ keys: [{ keyId: 'key-1', publicKey: privee }], approvers, rpId: 'x.example', origins: ['https://x.example'] }), { code: 'invalid_trust' });
});

test('la passkey d’un approbateur illisible rend la confiance invalide', () => {
  const signing = makeSigningKey();
  assert.throws(() => createTrust({
    keys: [{ keyId: signing.keyId, publicKey: signing.publicKey }],
    approvers: [{ id: 'approver-1', credentials: [{ id: 'cred-1', publicKey: 'illisible' }] }],
    rpId: 'x.example', origins: ['https://x.example']
  }), { code: 'invalid_trust' });
});

test('signer une validation avec une clé privée illisible ou d’un autre type est refusé', () => {
  const validation = { propositionId: 'p', digest: 'd', decision: 'approve', environment: 'production', approvals: [], issuedAt: new Date().toISOString(), expiresAt: new Date().toISOString() };
  for (const privateKey of ['illisible', Buffer.from('rien').toString('base64'), '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----']) {
    assert.throws(() => signValidation(validation, { privateKey, keyId: 'key-1' }), { code: 'invalid_key' });
  }
  const ecdsa = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  assert.throws(() => signValidation(validation, { privateKey: ecdsa, keyId: 'key-1' }), { code: 'invalid_key' });
  assert.throws(() => signValidation(validation, { privateKey: makeSigningKey().privateKey, keyId: 'mauvais id !' }), { code: 'invalid_key' });
});

test('le magasin mémoire refuse une autre proposition sous le même identifiant', async () => {
  const store = createMemoryGovernanceStore();
  const record = { organisationId: 'org-a', id: 'prop-1', digest: 'empreinte-a', status: 'awaiting_validation' };
  assert.equal((await store.put(record)).created, true);
  assert.equal((await store.put({ ...record })).created, false);
  await assert.rejects(store.put({ ...record, digest: 'empreinte-b' }), { code: 'proposal_conflict' });
  /* La même identité dans une autre organisation est une autre proposition. */
  assert.equal((await store.put({ ...record, organisationId: 'org-b', digest: 'empreinte-b' })).created, true);
});

test('une annulation dont l’écriture plante revient à « exécuté », trace l’échec et ne touche pas aux données', async () => {
  const inner = createMemoryConnector({ resources: RESOURCES, data: DATA });
  let panne = false;
  const connector = { ...inner, execute: (plan, hooks) => (panne ? Promise.reject(new Error('base indisponible')) : inner.execute(plan, hooks)) };
  const { governance, shop } = makeGovernance({ connector, rules: [{ id: 'notice', level: 'free_with_notice', match: { resources: ['products'] } }] });
  const done = await governance.propose(proposalInput());
  assert.equal(done.status, 'executed');
  const apres = JSON.stringify(shop.snapshot('products'));
  panne = true;
  const out = await governance.undo(done.proposal.id, { organisationId: 'org-a', by: { kind: 'human', id: 'user-7' } });
  assert.equal(out.code, 'execution_failed');
  assert.equal(out.status, 'executed');
  assert.equal(JSON.stringify(shop.snapshot('products')), apres);
  /* La panne passée, l'annulation reste possible. */
  panne = false;
  const ensuite = await governance.undo(done.proposal.id, { organisationId: 'org-a', by: { kind: 'human', id: 'user-7' } });
  assert.equal(ensuite.status, 'undone');
});
