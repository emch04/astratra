const express = require('express');
const request = require('supertest');
const { createAppleWebServiceRouter, createMemoryRegistrationStore } = require('../src');

const PASS_TYPE = 'pass.com.test.fidelite';
const JETON = 'jeton-de-la-carte-123456';

function app({ configure = true, updatedAt = '2026-09-22T10:00:00Z' } = {}) {
  const registrations = createMemoryRegistrationStore();
  const logs = [];
  const serveur = express();
  serveur.use(express.json());
  serveur.use('/wallet/apple', createAppleWebServiceRouter({
    resolveConfig: async () => (configure ? { passTypeIdentifier: PASS_TYPE } : null),
    findPass: async (serial) => (serial === 'C-1' ? { authenticationToken: JETON, updatedAt } : null),
    buildPass: async () => Buffer.from('pkpass'),
    registrations,
    logger: { warn: (message) => logs.push(message) }
  }));
  return { serveur, registrations, logs };
}

const inscription = `/wallet/apple/v1/devices/d1/registrations/${PASS_TYPE}/C-1`;

test('inscrit un appareil authentifié : 201 puis 200', async () => {
  const { serveur } = app();
  const auth = { Authorization: `ApplePass ${JETON}` };
  expect((await request(serveur).post(inscription).set(auth).send({ pushToken: 't1' })).status).toBe(201);
  expect((await request(serveur).post(inscription).set(auth).send({ pushToken: 't2' })).status).toBe(200);
});

test('refuse sans le bon jeton, une carte inconnue ou un autre type de carte', async () => {
  const { serveur } = app();
  expect((await request(serveur).post(inscription).set({ Authorization: 'ApplePass faux' }).send({ pushToken: 't' })).status).toBe(401);
  expect((await request(serveur).post(inscription.replace('C-1', 'C-9')).set({ Authorization: `ApplePass ${JETON}` }).send({ pushToken: 't' })).status).toBe(404);
  expect((await request(serveur).post(inscription.replace(PASS_TYPE, 'pass.autre')).send({ pushToken: 't' })).status).toBe(404);
});

test('liste les cartes changées depuis une date, 204 sinon', async () => {
  const { serveur } = app();
  await request(serveur).post(inscription).set({ Authorization: `ApplePass ${JETON}` }).send({ pushToken: 't' });
  const liste = `/wallet/apple/v1/devices/d1/registrations/${PASS_TYPE}`;
  const avant = await request(serveur).get(liste).query({ passesUpdatedSince: '2026-01-01T00:00:00Z' });
  expect(avant.body).toEqual({ serialNumbers: ['C-1'], lastUpdated: '2026-09-22T10:00:00.000Z' });
  expect((await request(serveur).get(liste).query({ passesUpdatedSince: '2026-12-01T00:00:00Z' })).status).toBe(204);
});

test('renvoie la dernière version signée, puis désinscrit', async () => {
  const { serveur, registrations } = app();
  const auth = { Authorization: `ApplePass ${JETON}` };
  const carte = await request(serveur).get(`/wallet/apple/v1/passes/${PASS_TYPE}/C-1`).set(auth);
  expect(carte.status).toBe(200);
  expect(carte.headers['content-type']).toMatch(/application\/vnd.apple.pkpass/);
  await request(serveur).post(inscription).set(auth).send({ pushToken: 't' });
  expect((await request(serveur).delete(inscription).set(auth)).status).toBe(200);
  expect(await registrations.listForPass(PASS_TYPE, 'C-1')).toEqual([]);
});

test('503 tant qu’Apple Wallet n’est pas configuré ; les journaux sont relayés', async () => {
  const { serveur, logs } = app({ configure: false });
  expect((await request(serveur).get(`/wallet/apple/v1/passes/${PASS_TYPE}/C-1`)).status).toBe(503);
  await request(serveur).post('/wallet/apple/v1/log').send({ logs: ['erreur appareil'] });
  expect(logs).toEqual(['Apple Wallet: erreur appareil']);
});

describe('ce que le service web refuse', () => {
  function appAvec(pass) {
    const serveur = express();
    serveur.use(express.json());
    serveur.use('/wallet/apple', createAppleWebServiceRouter({
      resolveConfig: async () => ({ passTypeIdentifier: PASS_TYPE }),
      findPass: async () => pass,
      buildPass: async () => Buffer.from('pkpass'),
      registrations: createMemoryRegistrationStore(),
      logger: { warn() {} }
    }));
    return serveur;
  }

  test('une carte enregistrée sans jeton ne s’ouvre avec aucun en-tête, pas même « ApplePass undefined »', async () => {
    for (const authenticationToken of [undefined, null, '']) {
      const serveur = appAvec({ authenticationToken, updatedAt: '2026-09-22T10:00:00Z' });
      for (const header of [undefined, 'ApplePass undefined', 'ApplePass null', 'ApplePass ', 'ApplePass']) {
        const req = request(serveur).get(`/wallet/apple/v1/passes/${PASS_TYPE}/C-1`);
        const res = await (header === undefined ? req : req.set({ Authorization: header }));
        expect(res.status).toBe(401);
      }
    }
  });

  test('un jeton proche du bon ne passe pas : préfixe, autre casse, espace en trop', async () => {
    const { serveur } = app();
    for (const header of [`ApplePass ${JETON.slice(0, -1)}`, `ApplePass ${JETON}x`, `applepass ${JETON}`, `ApplePass  ${JETON}`, `Bearer ${JETON}`, JETON]) {
      expect((await request(serveur).get(`/wallet/apple/v1/passes/${PASS_TYPE}/C-1`).set({ Authorization: header })).status).toBe(401);
    }
  });

  test('une inscription authentifiée sans jeton de notification est refusée, et rien n’est inscrit', async () => {
    const { serveur, registrations } = app();
    const auth = { Authorization: `ApplePass ${JETON}` };
    for (const body of [{}, { pushToken: '' }, { pushToken: 42 }, { pushToken: ['t'] }]) {
      expect((await request(serveur).post(inscription).set(auth).send(body)).status).toBe(400);
    }
    expect(await registrations.listForDevice('d1', PASS_TYPE)).toEqual([]);
  });

  test('le journal public ne laisse ni forger de lignes, ni l’inonder', async () => {
    const { serveur, logs } = app();
    await request(serveur).post('/wallet/apple/v1/log').send({ logs: ['ligne\nAUDIT: connexion admin réussie\r\nautre', ...Array.from({ length: 200 }, (_, i) => `m${i}`), 'x'.repeat(5000)] });
    expect(logs.length).toBeLessThanOrEqual(20);
    for (const ligne of logs) {
      expect(ligne).not.toMatch(/[\r\n]/);
      expect(ligne.length).toBeLessThanOrEqual(600);
    }
    expect(logs[0]).toBe('Apple Wallet: ligne AUDIT: connexion admin réussie autre');
  });
});
