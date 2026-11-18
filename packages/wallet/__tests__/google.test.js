const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URLSearchParams } = require('node:url');
const { createGoogleWallet, signSaveJwt } = require('../src');

const CLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'pass-test.key'), 'utf8');
const PUBLIQUE = crypto.createPublicKey(CLE);
const credentials = { client_email: 'wallet@test.iam.gserviceaccount.com', private_key: CLE };

function fauxGoogle(existants = new Set()) {
  const appels = [];
  const request = async (options) => {
    appels.push(options);
    if (options.method === 'PATCH' && !existants.has(options.data.id)) {
      const erreur = new Error('absent'); erreur.response = { status: 404 }; throw erreur;
    }
    existants.add(options.data.id);
    return { data: options.data };
  };
  return { request, appels };
}

test('le lien d’ajout porte un JWT RS256 vérifiable, signé par le compte de service', () => {
  const wallet = createGoogleWallet({ issuerId: '3388', credentials, request: async () => ({}) });
  const lien = wallet.saveLink([{ id: '3388.C-1', classId: '3388.fidelite', autre: 'ignoré' }]);
  const jwt = lien.replace('https://pay.google.com/gp/v/save/', '');
  const [entete, corps, signature] = jwt.split('.');
  expect(crypto.createVerify('RSA-SHA256').update(`${entete}.${corps}`).verify(PUBLIQUE, signature, 'base64url')).toBe(true);
  const contenu = JSON.parse(Buffer.from(corps, 'base64url').toString());
  expect(contenu).toMatchObject({ iss: credentials.client_email, aud: 'google', typ: 'savetowallet' });
  expect(contenu.payload).toEqual({ loyaltyObjects: [{ id: '3388.C-1', classId: '3388.fidelite' }] });
});

test('crée la classe au premier appel (404 puis POST), une seule fois par définition', async () => {
  const { request, appels } = fauxGoogle();
  const wallet = createGoogleWallet({ issuerId: '3388', credentials, request });
  const definition = { id: wallet.classId('fidelite'), issuerName: 'Salon', programName: 'Fidélité' };
  await wallet.ensureClass(definition);
  await wallet.ensureClass(definition);
  expect(appels.map((a) => `${a.method} ${a.url.split('/v1/')[1]}`)).toEqual([
    'PATCH loyaltyClass/3388.fidelite', 'POST loyaltyClass'
  ]);
  expect(appels[1].data.reviewStatus).toBe('UNDER_REVIEW');
});

test('met à jour une carte existante sans la recréer', async () => {
  const { request, appels } = fauxGoogle(new Set(['3388.C-1']));
  const wallet = createGoogleWallet({ issuerId: '3388', credentials, request });
  await wallet.upsertObject({ id: wallet.objectId('C-1'), classId: '3388.fidelite', state: 'ACTIVE' });
  expect(appels).toHaveLength(1);
  expect(appels[0].method).toBe('PATCH');
});

test('les identifiants sont nettoyés, les types inconnus refusés', () => {
  const wallet = createGoogleWallet({ issuerId: '3388', credentials, request: async () => ({}) });
  expect(wallet.objectId('carte n°1')).toBe('3388.carte_n_1');
  expect(() => createGoogleWallet({ issuerId: '1', credentials, kind: 'avion' })).toThrow(/inconnu/);
  expect(signSaveJwt({}, credentials).split('.')).toHaveLength(3);
});

describe('ce que Google refuse', () => {
  test('une erreur de Google autre que 404 remonte telle quelle, sans tentative de création', async () => {
    const appels = [];
    const request = async (options) => { appels.push(options.method); const e = new Error('refusé'); e.response = { status: 403 }; throw e; };
    const wallet = createGoogleWallet({ issuerId: '3388', credentials, request });
    await expect(wallet.upsertObject({ id: wallet.objectId('C-1'), classId: '3388.fidelite' })).rejects.toThrow('refusé');
    expect(appels).toEqual(['PATCH']);
  });

  test('une classe qui n’a pas pu être créée n’est pas tenue pour prête : l’appel suivant réessaie', async () => {
    let panne = true;
    const appels = [];
    const request = async (options) => {
      appels.push(options.method);
      if (panne) { const e = new Error('réseau'); e.response = { status: 503 }; throw e; }
      return { data: options.data };
    };
    const wallet = createGoogleWallet({ issuerId: '3388', credentials, request });
    const definition = { id: wallet.classId('fidelite'), issuerName: 'Salon', programName: 'Fidélité' };
    await expect(wallet.ensureClass(definition)).rejects.toThrow('réseau');
    panne = false;
    await wallet.ensureClass(definition);
    expect(appels).toEqual(['PATCH', 'PATCH']);
  });
});

/* Le vrai chemin, sans remplacer le client : le jeton du compte de service vient de @astratra/core (plus de
   google-auth-library), puis la carte est créée chez un faux Google. */
describe('Google Wallet par le jeton de @astratra/core', () => {
  const reponse = (status, corps) => ({ ok: status >= 200 && status < 300, status, headers: new Map(), json: async () => corps, text: async () => JSON.stringify(corps) });

  test('le jeton est échangé une fois, la carte absente est créée (PATCH 404 puis POST), avec le jeton', async () => {
    const appels = [];
    const fetch = async (url, init) => {
      appels.push({ url, method: init.method, authorization: init.headers && init.headers.authorization });
      if (url === 'https://oauth2.googleapis.com/token') {
        const assertion = new URLSearchParams(init.body).get('assertion');
        const [h, c, s] = assertion.split('.');
        expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), PUBLIQUE, Buffer.from(s, 'base64url'))).toBe(true);
        expect(JSON.parse(Buffer.from(c, 'base64url')).scope).toBe('https://www.googleapis.com/auth/wallet_object.issuer');
        return reponse(200, { access_token: 'jeton-wallet', expires_in: 3599 });
      }
      if (init.method === 'PATCH') return reponse(404, { error: { message: 'absente' } });
      return reponse(200, JSON.parse(init.body));
    };
    const wallet = createGoogleWallet({ issuerId: '3388', credentials, fetch });
    await wallet.upsertObject({ id: '3388.carte-1', classId: '3388.C-1' });
    await wallet.upsertObject({ id: '3388.carte-2', classId: '3388.C-1' });
    expect(appels.filter((a) => a.url.endsWith('/token'))).toHaveLength(1);
    expect(appels.filter((a) => !a.url.endsWith('/token')).map((a) => `${a.method} ${a.authorization}`)).toEqual(['PATCH Bearer jeton-wallet', 'POST Bearer jeton-wallet', 'PATCH Bearer jeton-wallet', 'POST Bearer jeton-wallet']);
  });

  test('un compte de service à l’adresse d’échange hors de Google est refusé à la première carte, sans rien envoyer', async () => {
    const appels = [];
    const fetch = async (url) => { appels.push(url); return reponse(200, {}); };
    const wallet = createGoogleWallet({ issuerId: '3388', credentials: { ...credentials, token_uri: 'https://jetons.example.test/token' }, fetch });
    await expect(wallet.upsertObject({ id: '3388.x', classId: '3388.C' })).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_URI_REFUSED' });
    expect(appels).toEqual([]);
  });
});
