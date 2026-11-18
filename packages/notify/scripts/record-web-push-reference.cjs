'use strict';

/*
 * Enregistre, une fois, les réponses de web-push 3.6.7 et de http_ece 1.2.0 pour comparer le module Web Push de notify
 * (__tests__/fixtures/web-push-reference.json). Ni l'un ni l'autre n'est une dépendance d'Astratra : le chemin d'un
 * projet qui a installé web-push est donné en argument.
 *   node scripts/record-web-push-reference.cjs /chemin/vers/node_modules/web-push
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const webPushDir = path.resolve(process.argv[2]);
const webpush = require(webPushDir);
const ece = require(require.resolve('http_ece', { paths: [webPushDir] }));
const encryptionHelper = require(path.join(webPushDir, 'src/encryption-helper.js'));
const vapidHelper = require(path.join(webPushDir, 'src/vapid-helper.js'));
const { gen, createRandom } = require('@astratra/testkit/security');

const random = createRandom('web-push-reference');
const b64 = (buffer) => Buffer.from(buffer).toString('base64url');
const keyPair = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const privateKey = ecdh.getPrivateKey();
  return { ecdh, publicKey: b64(ecdh.getPublicKey()), privateKey: b64(Buffer.concat([Buffer.alloc(32 - privateKey.length), privateKey])) };
};
const texts = [gen.string({ min: 1, max: 300, alphabet: 'unicode' }), gen.string({ min: 1, max: 3993, alphabet: 'ascii' }), gen.hostileString(), gen.bytes({ min: 1, max: 3993 })];
const payloadOf = (i) => {
  const fixed = [0, 1, 2, 15, 16, 17, 100, 1000, 3992, 3993];
  if (i < fixed.length) return Buffer.alloc(fixed[i], 0x61 + (i % 26));
  const value = random.pick(texts).generate(random.fork(`p${i}`));
  const bytes = Buffer.from(value);
  return bytes.subarray(0, 3993);
};

// 1. Le chiffrement, à sel et clé éphémère fixés : les octets de http_ece.
const eceCases = [];
for (let i = 0; i < 60; i++) {
  const ua = keyPair();
  const as = keyPair();
  const auth = crypto.randomBytes(i % 7 === 6 ? 32 : 16);
  const salt = crypto.randomBytes(16);
  const payload = payloadOf(i);
  const body = ece.encrypt(payload, { version: 'aes128gcm', dh: ua.publicKey, privateKey: as.ecdh, salt: b64(salt), authSecret: b64(auth) });
  eceCases.push({ uaPublic: ua.publicKey, uaPrivate: ua.privateKey, auth: b64(auth), asPrivate: as.privateKey, salt: b64(salt), payload: b64(payload), body: b64(body) });
}

// 2. Des messages chiffrés par web-push lui-même (sel et clé tirés au hasard) : ils doivent se déchiffrer.
const webPushCiphertexts = [];
for (let i = 0; i < 40; i++) {
  const ua = keyPair();
  const auth = crypto.randomBytes(16);
  const payload = payloadOf(i + 3).length ? payloadOf(i + 3) : Buffer.from('x');
  const { cipherText } = encryptionHelper.encrypt(ua.publicKey, b64(auth), payload, 'aes128gcm');
  webPushCiphertexts.push({ uaPublic: ua.publicKey, uaPrivate: ua.privateKey, auth: b64(auth), payload: b64(payload), body: b64(cipherText) });
}

// 3. VAPID : l'en-tête Authorization de web-push, à échéance fixée.
const recordedAt = Math.floor(Date.now() / 1000);
const audiences = ['https://fcm.googleapis.com', 'https://updates.push.services.mozilla.com', 'https://web.push.apple.com', 'https://wns2-par02p.notify.windows.com', 'https://push.example.test:8443'];
const subjects = ['mailto:contact@example.test', 'https://www.example.test/contact', 'mailto:équipe@exemple.test', 'https://example.test'];
const vapidCases = [];
for (let i = 0; i < 20; i++) {
  const keys = webpush.generateVAPIDKeys();
  const audience = audiences[i % audiences.length];
  const subject = subjects[i % subjects.length];
  const expiration = recordedAt + 600 + i * 3600;
  const { Authorization } = vapidHelper.getVapidHeaders(audience, subject, keys.publicKey, keys.privateKey, 'aes128gcm', expiration);
  vapidCases.push({ ...keys, audience, subject, expiration, authorization: Authorization });
}

// 4. Les en-têtes de generateRequestDetails, pour une grille d'options.
const ua = keyPair();
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def', keys: { p256dh: ua.publicKey, auth: b64(crypto.randomBytes(16)) } };
const vapidDetails = { subject: 'mailto:contact@example.test', ...webpush.generateVAPIDKeys() };
const requestCases = [
  ['texte, sans option', 'bonjour', undefined],
  ['sans message', undefined, undefined],
  ['message vide', '', undefined],
  ['Buffer', Buffer.from([1, 2, 3]), undefined],
  ['TTL 0', 'x', { TTL: 0 }],
  ['TTL 60', 'x', { TTL: 60 }],
  ['TTL en texte', 'x', { TTL: '120' }],
  ['urgence haute', 'x', { urgency: 'high' }],
  ['urgence très basse', 'x', { urgency: 'very-low' }],
  ['sujet', 'x', { topic: 'abc_-XYZ09' }],
  ['en-tête en plus', 'x', { headers: { 'X-Extra': 'oui' } }],
  ['avec VAPID', 'x', { vapidDetails }],
  ['VAPID sans message', undefined, { vapidDetails }],
  ['tout', 'x'.repeat(500), { vapidDetails, TTL: 3600, urgency: 'low', topic: 'maj' }],
].map(([id, payload, options]) => {
  const details = webpush.generateRequestDetails(subscription, payload, options);
  const headers = Object.fromEntries(Object.entries(details.headers).map(([k, v]) => [k, k === 'Authorization' ? 'present' : String(v)]));
  return { id, payload: payload === undefined ? null : Buffer.isBuffer(payload) ? { buffer: b64(payload) } : payload, options: options ? { ...options, ...(options.vapidDetails ? { vapidDetails: 'valid' } : {}) } : null, headers, bodyLength: details.body ? details.body.length : 0 };
});

// 5. Ce que web-push refuse ou accepte (generateRequestDetails, avec des clés VAPID valides sauf mention).
const offCurve = Buffer.alloc(65, 1);
offCurve[0] = 4;
const refusalCases = [
  ['sans abonnement', null, 'x', {}],
  ['sans adresse', { keys: subscription.keys }, 'x', {}],
  ['adresse vide', { ...subscription, endpoint: '' }, 'x', {}],
  ['adresse nombre', { ...subscription, endpoint: 42 }, 'x', {}],
  ['message sans clés', { endpoint: subscription.endpoint }, 'x', {}],
  ['sans message ni clés', { endpoint: subscription.endpoint }, undefined, {}],
  ['p256dh de 64 octets', { ...subscription, keys: { ...subscription.keys, p256dh: b64(Buffer.alloc(64, 4)) } }, 'x', {}],
  ['p256dh hors de la courbe', { ...subscription, keys: { ...subscription.keys, p256dh: b64(offCurve) } }, 'x', {}],
  ['auth de 15 octets', { ...subscription, keys: { ...subscription.keys, auth: b64(Buffer.alloc(15)) } }, 'x', {}],
  ['auth de 32 octets', { ...subscription, keys: { ...subscription.keys, auth: b64(Buffer.alloc(32, 7)) } }, 'x', {}],
  ['message nombre', subscription, 42, {}],
  ['option inconnue', subscription, 'x', { retry: 3 }],
  ['TTL négatif', subscription, 'x', { TTL: -1 }],
  ['TTL pas un nombre', subscription, 'x', { TTL: 'abc' }],
  ['TTL décimal', subscription, 'x', { TTL: 1.5 }],
  ['urgence inconnue', subscription, 'x', { urgency: 'urgent' }],
  ['sujet avec +', subscription, 'x', { topic: 'a+b' }],
  ['sujet de 33 caractères', subscription, 'x', { topic: 'a'.repeat(33) }],
  ['encodage inconnu', subscription, 'x', { contentEncoding: 'gzip' }],
  ['encodage aesgcm', subscription, 'x', { contentEncoding: 'aesgcm' }],
  ['en-tête en double', subscription, 'x', { TTL: 5, headers: { TTL: 6 } }],
  ['VAPID sujet http', subscription, 'x', { vapidDetails: { ...vapidDetails, subject: 'http://example.test' } }],
  ['VAPID sujet vide', subscription, 'x', { vapidDetails: { ...vapidDetails, subject: '' } }],
  ['VAPID clé publique de 64 octets', subscription, 'x', { vapidDetails: { ...vapidDetails, publicKey: b64(Buffer.alloc(64, 4)) } }],
  ['VAPID clé privée de 31 octets', subscription, 'x', { vapidDetails: { ...vapidDetails, privateKey: b64(Buffer.alloc(31, 1)) } }],
  ['VAPID clé avec =', subscription, 'x', { vapidDetails: { ...vapidDetails, privateKey: `${vapidDetails.privateKey}=` } }],
  ['VAPID clés qui ne vont pas ensemble', subscription, 'x', { vapidDetails: { ...vapidDetails, publicKey: webpush.generateVAPIDKeys().publicKey } }],
  ['adresse http://', { ...subscription, endpoint: 'http://fcm.googleapis.com/fcm/send/x' }, 'x', {}],
  ['adresse sur un hôte inconnu', { ...subscription, endpoint: 'https://169.254.169.254/latest/meta-data' }, 'x', {}],
  ['adresse avec identifiants', { ...subscription, endpoint: 'https://user:pass@fcm.googleapis.com/fcm/send/x' }, 'x', {}],
  ['message de 3 994 octets', subscription, 'x'.repeat(3994), {}],
  ['message de 3 993 octets', subscription, 'x'.repeat(3993), {}],
  ['clé GCM', subscription, 'x', { gcmAPIKey: 'AAAA' }],
].map(([id, sub, payload, options]) => {
  let outcome = 'accepted';
  try {
    webpush.generateRequestDetails(sub, payload, options);
  } catch {
    outcome = 'refused';
  }
  return { id, outcome };
});

const out = {
  source: `web-push ${require(path.join(webPushDir, 'package.json')).version} et http_ece ${require(require.resolve('http_ece/package.json', { paths: [webPushDir] })).version}`,
  recordedAt,
  eceCases,
  webPushCiphertexts,
  vapidCases,
  requestSubscription: subscription,
  requestCases,
  refusalCases,
};
fs.writeFileSync(path.join(__dirname, '../__tests__/fixtures/web-push-reference.json'), `${JSON.stringify(out, null, 1)}\n`);
process.stdout.write(`${eceCases.length} chiffrements, ${webPushCiphertexts.length} messages, ${vapidCases.length} en-têtes VAPID, ${requestCases.length} requêtes, ${refusalCases.length} cas de refus.\n`);
