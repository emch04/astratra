const crypto = require('node:crypto');
const https = require('node:https');

/*
 * Web Push, sans bibliothèque : le chiffrement du message (RFC 8291 sur RFC 8188, « aes128gcm »), la signature du
 * serveur (VAPID, RFC 8292) et l'envoi au service de notification du navigateur (RFC 8030), avec node:crypto et
 * node:https. Il remplace web-push : mêmes octets que http_ece à sel et clé égaux, mêmes en-têtes que web-push 3.6.7,
 * vecteur de la RFC 8291 vérifié.
 *
 * Différences voulues avec web-push :
 *   - l'adresse d'un abonnement doit être en https:// et viser un service de notification connu (KNOWN_PUSH_HOSTS,
 *     plus `extraHosts`) : sinon, n'importe quel abonné ferait appeler n'importe quelle adresse au serveur ;
 *   - la réponse du service est lue jusqu'à 64 Kio, un délai de 30 s s'applique par défaut, une redirection n'est
 *     jamais suivie ;
 *   - un message de plus de 3 993 octets est refusé (la limite de la RFC 8291), une clé d'appareil hors de la courbe
 *     aussi, avant tout envoi ;
 *   - la clé publique VAPID doit aller avec la clé privée (web-push enverrait, et le service répondrait 403) ;
 *   - une échéance VAPID passée, un TTL qui n'est pas un entier, un en-tête en double ou mal formé sont refusés ;
 *   - seul « aes128gcm » est pris : « aesgcm » (brouillon de 2016) et les clés GCM (service fermé en 2019) ne
 *     servent plus ; un mandataire passe par `agent`.
 * Toute erreur d'entrée est une WebPushError de code « invalid_request », sans `statusCode` ; une réponse du service
 * hors 2xx est une WebPushError avec `statusCode`, `headers`, `body` et `endpoint`, comme web-push.
 */

const KNOWN_PUSH_HOSTS = Object.freeze(['fcm.googleapis.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com']);
const DEFAULT_TTL = 2_419_200; // quatre semaines, comme web-push
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_EXPIRATION_SECONDS = 12 * 3600;
const MAX_EXPIRATION_SECONDS = 24 * 3600;
const RECORD_SIZE = 4096;
const MAX_PAYLOAD = 3993; // RFC 8291, section 4 : 4096 − 86 (en-tête) − 16 (étiquette) − 1 (délimiteur)
const MAX_RESPONSE = 64 * 1024;
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high']);
const MANAGED_HEADERS = new Set(['ttl', 'content-length', 'content-type', 'content-encoding', 'authorization', 'urgency', 'topic', 'host', 'crypto-key', 'encryption']);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const B64_ANY = /^[A-Za-z0-9+/_-]+={0,2}$/;
const OPTION_KEYS = new Set(['vapid', 'vapidDetails', 'ttl', 'TTL', 'urgency', 'topic', 'headers', 'timeoutMs', 'timeout', 'agent', 'extraHosts', 'allowAnyHost', 'expiration', 'contentEncoding', 'now']);

class WebPushError extends Error {
  constructor(message, { statusCode, headers, body, endpoint, code } = {}) {
    super(message);
    this.name = 'WebPushError';
    if (code) this.code = code;
    if (statusCode !== undefined) this.statusCode = statusCode;
    if (headers !== undefined) this.headers = headers;
    if (body !== undefined) this.body = body;
    if (endpoint !== undefined) this.endpoint = endpoint;
  }
}

const invalid = (message) => new WebPushError(message, { code: 'invalid_request' });

/** Une clé d'abonnement : base64url (ou base64, avec ou sans « = »), comme le navigateur la donne. */
function decodeSubscriptionKey(value, name, { min, max }) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !B64_ANY.test(value)) throw invalid(`subscription keys.${name} must be a base64url string`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < min || bytes.length > max) throw invalid(min === max ? `subscription keys.${name} must be ${min} bytes` : `subscription keys.${name} must be ${min} to ${max} bytes`);
  return bytes;
}

/** Une clé VAPID : base64url strict, sans « = » (comme web-push). */
function decodeVapidKey(value, name, length) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100 || !B64URL.test(value)) throw invalid(`VAPID ${name} must be a URL-safe base64 string without "="`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length) throw invalid(`VAPID ${name} must be ${length} bytes long when decoded`);
  return bytes;
}

/** Un point P-256 non compressé (65 octets, 0x04 en tête) qui est bien sur la courbe. */
function checkPoint(bytes, name) {
  if (bytes[0] !== 0x04) throw invalid(`${name} must be an uncompressed P-256 point`);
  try {
    crypto.ECDH.convertKey(bytes, 'prime256v1', undefined, undefined, 'uncompressed');
  } catch {
    throw invalid(`${name} is not a point on P-256`);
  }
  return bytes;
}

function checkSubject(subject) {
  if (typeof subject !== 'string' || !subject || subject.length > 512) throw invalid('VAPID subject must be an https: URL or a mailto: address');
  let parsed;
  try {
    parsed = new URL(subject);
  } catch {
    throw invalid('VAPID subject is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') throw invalid('VAPID subject must be an https: URL or a mailto: address');
  return subject;
}

/**
 * Les clés VAPID lues une fois : le sujet, la clé publique, et la clé privée en objet KeyObject. La clé publique doit
 * être celle de la clé privée.
 */
function parseVapid(vapid) {
  if (!vapid || typeof vapid !== 'object') throw invalid('vapid must be { subject, publicKey, privateKey }');
  const subject = checkSubject(vapid.subject);
  const publicBytes = checkPoint(decodeVapidKey(vapid.publicKey, 'public key', 65), 'VAPID public key');
  const privateBytes = decodeVapidKey(vapid.privateKey, 'private key', 32);
  const ecdh = crypto.createECDH('prime256v1');
  try {
    ecdh.setPrivateKey(privateBytes);
  } catch {
    throw invalid('VAPID private key is not a valid P-256 key');
  }
  if (!ecdh.getPublicKey().equals(publicBytes)) throw invalid('VAPID public key does not match the private key');
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: privateBytes.toString('base64url'), x: publicBytes.subarray(1, 33).toString('base64url'), y: publicBytes.subarray(33).toString('base64url') },
  });
  return { subject, publicKey: vapid.publicKey, key };
}

/** Une paire de clés VAPID neuve, au format de web-push (base64url : 65 octets publics, 32 privés). */
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  // Une clé privée qui commence par des zéros sort plus courte : elle est complétée à 32 octets (comme web-push).
  const privateKey = ecdh.getPrivateKey();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: Buffer.concat([Buffer.alloc(32 - privateKey.length), privateKey]).toString('base64url') };
}

const b64json = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * L'en-tête Authorization VAPID (RFC 8292) : « vapid t=<JWT ES256>, k=<clé publique> ». `audience` est l'origine du
 * service (« https://fcm.googleapis.com ») ; `expiration` (secondes) au plus 24 h plus tard, 12 h par défaut.
 */
function vapidAuthorization({ audience, vapid, expiration, now = Date.now } = {}) {
  const parsed = vapid && vapid.key ? vapid : parseVapid(vapid);
  let origin;
  try {
    origin = new URL(audience);
  } catch {
    throw invalid('VAPID audience must be the origin of a push service');
  }
  if (origin.protocol !== 'https:' || `${origin.protocol}//${origin.host}` !== audience) throw invalid('VAPID audience must be an https origin, without path');
  const seconds = Math.floor(now() / 1000);
  let exp = seconds + DEFAULT_EXPIRATION_SECONDS;
  if (expiration !== undefined) {
    if (!Number.isInteger(expiration) || expiration <= seconds) throw invalid('VAPID expiration must be a future timestamp in seconds');
    if (expiration > seconds + MAX_EXPIRATION_SECONDS) throw invalid('VAPID expiration must be at most 24 hours ahead');
    exp = expiration;
  }
  const unsigned = `${b64json({ typ: 'JWT', alg: 'ES256' })}.${b64json({ aud: audience, exp, sub: parsed.subject })}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: parsed.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { authorization: `vapid t=${unsigned}.${signature}, k=${parsed.publicKey}`, expiration: exp };
}

function toPayload(payload) {
  if (payload === undefined || payload === null || payload === '') return null;
  let bytes;
  if (typeof payload === 'string') bytes = Buffer.from(payload, 'utf8');
  else if (payload instanceof Uint8Array) bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  else throw invalid('payload must be a string or a Buffer');
  // La taille est vérifiée par encryptWebPush.
  return bytes.length === 0 ? null : bytes;
}

/**
 * Chiffre un message pour un abonnement (RFC 8291, un seul enregistrement aes128gcm). Rend le corps à envoyer :
 * en-tête de 86 octets (sel, taille d'enregistrement, clé publique éphémère du serveur) puis le texte chiffré.
 * `deterministic: { salt, privateKey }` (base64url) ne sert qu'aux vecteurs d'essai : un sel réutilisé avec la même
 * clé éphémère révèle les messages.
 */
function encryptWebPush({ p256dh, auth, payload, deterministic } = {}) {
  const uaPublic = checkPoint(decodeSubscriptionKey(p256dh, 'p256dh', { min: 65, max: 65 }), 'subscription keys.p256dh');
  const authSecret = decodeSubscriptionKey(auth, 'auth', { min: 16, max: 64 });
  const plaintext = typeof payload === 'string' || payload instanceof Uint8Array ? Buffer.from(payload) : null;
  if (!plaintext) throw invalid('payload must be a string or a Buffer');
  if (plaintext.length > MAX_PAYLOAD) throw invalid(`payload must be at most ${MAX_PAYLOAD} bytes (RFC 8291)`);
  const ecdh = crypto.createECDH('prime256v1');
  let salt;
  if (deterministic) {
    try {
      ecdh.setPrivateKey(Buffer.from(String(deterministic.privateKey), 'base64url'));
    } catch {
      throw invalid('deterministic.privateKey is not a valid P-256 key');
    }
    salt = Buffer.from(String(deterministic.salt), 'base64url');
    if (salt.length !== 16) throw invalid('deterministic.salt must be 16 bytes');
  } else {
    ecdh.generateKeys();
    salt = crypto.randomBytes(16);
  }
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 : le délimiteur du dernier (et seul) enregistrement, sans remplissage.
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/**
 * Le côté de l'appareil (pour les essais, ou un récepteur écrit en Node) : déchiffre un corps aes128gcm avec la clé
 * privée de l'abonnement (`privateKey`, 32 octets en base64url), sa clé publique `p256dh` et `auth`.
 */
function decryptWebPush({ body, privateKey, p256dh, auth } = {}) {
  if (!(body instanceof Uint8Array)) throw invalid('body must be a Buffer');
  const data = Buffer.from(body);
  const uaPublic = checkPoint(decodeSubscriptionKey(p256dh, 'p256dh', { min: 65, max: 65 }), 'subscription keys.p256dh');
  const authSecret = decodeSubscriptionKey(auth, 'auth', { min: 16, max: 64 });
  if (data.length < 21 + 65 + 17) throw invalid('body is too short');
  const salt = data.subarray(0, 16);
  const recordSize = data.readUInt32BE(16);
  const idLength = data[20];
  if (idLength !== 65) throw invalid('body key id must be a 65-byte P-256 key');
  const asPublic = checkPoint(data.subarray(21, 86), 'body key id');
  const sealed = data.subarray(86);
  if (recordSize < 18 || sealed.length > recordSize) throw invalid('body must hold a single record');
  const ecdh = crypto.createECDH('prime256v1');
  try {
    ecdh.setPrivateKey(Buffer.from(String(privateKey), 'base64url'));
  } catch {
    throw invalid('privateKey is not a valid P-256 key');
  }
  if (!ecdh.getPublicKey().equals(uaPublic)) throw invalid('privateKey does not match p256dh');
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  } catch {
    throw new WebPushError('body could not be decrypted', { code: 'decrypt_failed' });
  }
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  if (end === 0 || plain[end - 1] !== 2) throw new WebPushError('body has no final record delimiter', { code: 'decrypt_failed' });
  return plain.subarray(0, end - 1);
}

/** L'adresse d'abonnement, vérifiée : https://, sans identifiants, sur un service connu (ou ajouté). */
function checkEndpoint(endpoint, { extraHosts = [], allowAnyHost = false } = {}) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 2048) throw invalid('subscription endpoint must be a URL');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid('subscription endpoint must be a URL');
  }
  if (url.protocol !== 'https:') throw invalid('subscription endpoint must use https://');
  if (url.username || url.password) throw invalid('subscription endpoint must not contain credentials');
  if (!Array.isArray(extraHosts) || extraHosts.some((h) => typeof h !== 'string' || !h)) throw invalid('extraHosts must be an array of host names');
  if (!allowAnyHost) {
    const host = url.hostname.toLowerCase();
    const allowed = [...KNOWN_PUSH_HOSTS, ...extraHosts.map((h) => h.toLowerCase())];
    if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) throw invalid(`subscription endpoint host ${host} is not a known push service (add it to extraHosts)`);
  }
  return url;
}

function readOptions(options) {
  if (options === undefined || options === null) options = {};
  if (typeof options !== 'object') throw invalid('options must be an object');
  for (const key of Object.keys(options)) {
    if (key === 'gcmAPIKey') throw invalid('gcmAPIKey is not supported: GCM closed in 2019, use VAPID');
    if (key === 'proxy') throw invalid('proxy is not supported: pass an https.Agent (for example a proxy agent) as agent');
    if (!OPTION_KEYS.has(key)) throw invalid(`'${key}' is an invalid option`);
  }
  const pick = (a, b) => {
    if (options[a] !== undefined && options[b] !== undefined) throw invalid(`give ${a} or ${b}, not both`);
    return options[a] !== undefined ? options[a] : options[b];
  };
  const vapid = pick('vapid', 'vapidDetails');
  let ttl = pick('ttl', 'TTL');
  if (ttl === undefined) ttl = DEFAULT_TTL;
  if (typeof ttl === 'string' && /^\d{1,10}$/.test(ttl)) ttl = Number(ttl);
  if (!Number.isSafeInteger(ttl) || ttl < 0) throw invalid('TTL must be a non-negative integer (seconds)');
  const urgency = options.urgency === undefined ? 'normal' : options.urgency;
  if (!URGENCIES.has(urgency)) throw invalid('urgency must be very-low, low, normal or high');
  const topic = options.topic;
  if (topic !== undefined && (typeof topic !== 'string' || !B64URL.test(topic) || topic.length > 32)) throw invalid('topic must be at most 32 URL-safe base64 characters');
  if (options.contentEncoding !== undefined && options.contentEncoding !== 'aes128gcm') throw invalid('only the aes128gcm content encoding is supported (aesgcm is an obsolete draft)');
  const timeoutMs = pick('timeoutMs', 'timeout') ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw invalid('timeout must be a number of milliseconds');
  const headers = options.headers ?? {};
  if (typeof headers !== 'object' || Array.isArray(headers)) throw invalid('headers must be an object');
  const extra = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw invalid(`header name ${JSON.stringify(name)} is not valid`);
    if (MANAGED_HEADERS.has(name.toLowerCase())) throw invalid(`header ${name} is set by the library; use the option instead`);
    const text = String(value);
    if (text.length > 1024 || /[\0\r\n]/.test(text)) throw invalid(`header ${name} has an invalid value`);
    extra[name] = text;
  }
  return { vapid, ttl, urgency, topic, timeoutMs, extra, agent: options.agent, extraHosts: options.extraHosts, allowAnyHost: options.allowAnyHost === true, expiration: options.expiration, now: options.now };
}

/**
 * La requête à envoyer, sans l'envoyer (comme generateRequestDetails de web-push) : { endpoint, method, headers, body }.
 * `payload` : texte ou Buffer (aucun message : une simple notification sans contenu).
 */
function buildWebPushRequest(subscription, payload, options) {
  const opts = readOptions(options);
  if (!subscription || typeof subscription !== 'object') throw invalid('subscription must be { endpoint, keys: { p256dh, auth } }');
  const url = checkEndpoint(subscription.endpoint, opts);
  const bytes = toPayload(payload);
  const headers = { TTL: String(opts.ttl), ...opts.extra };
  let body = null;
  if (bytes) {
    const keys = subscription.keys;
    if (!keys || typeof keys !== 'object') throw invalid('to send a payload, the subscription must have keys.p256dh and keys.auth');
    body = encryptWebPush({ p256dh: keys.p256dh, auth: keys.auth, payload: bytes });
    headers['Content-Length'] = String(body.length);
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Encoding'] = 'aes128gcm';
  } else {
    headers['Content-Length'] = '0';
  }
  if (opts.vapid) headers.Authorization = vapidAuthorization({ audience: `${url.protocol}//${url.host}`, vapid: opts.vapid, expiration: opts.expiration, now: opts.now }).authorization;
  headers.Urgency = opts.urgency;
  if (opts.topic) headers.Topic = opts.topic;
  return { endpoint: subscription.endpoint, method: 'POST', headers, body, timeoutMs: opts.timeoutMs, agent: opts.agent };
}

/** Envoie une requête préparée : une réponse 2xx rend { statusCode, body, headers }, une autre lève WebPushError. */
function deliver(request) {
  const url = new URL(request.endpoint);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = https.request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: request.headers,
        agent: request.agent,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        const done = (truncated) => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode <= 299) finish(resolve, { statusCode: res.statusCode, body: text, headers: res.headers });
          else finish(reject, new WebPushError(truncated ? 'Received unexpected response code (body truncated)' : 'Received unexpected response code', { statusCode: res.statusCode, headers: res.headers, body: text, endpoint: request.endpoint }));
        };
        res.on('data', (chunk) => {
          if (settled) return;
          const room = MAX_RESPONSE - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += chunk.length;
          if (size >= MAX_RESPONSE) {
            done(true);
            res.destroy();
          }
        });
        res.on('end', () => done(false));
        res.on('error', (error) => finish(reject, error));
      }
    );
    const timer = setTimeout(() => {
      const error = new WebPushError(`Push service did not answer within ${request.timeoutMs} ms`, { code: 'timeout', endpoint: request.endpoint });
      finish(reject, error);
      req.destroy(error);
    }, request.timeoutMs);
    timer.unref?.();
    req.on('error', (error) => finish(reject, error));
    if (request.body) req.write(request.body);
    req.end();
  });
}

/** Envoie une notification (comme webpush.sendNotification) : mêmes arguments, mêmes résultats, mêmes erreurs. */
async function sendWebPush(subscription, payload, options) {
  return deliver(buildWebPushRequest(subscription, payload, options));
}

/**
 * Un TRANSPORT pour createPushSender : `transport(subscription, payload)`, payload texte, Buffer ou objet (envoyé en
 * JSON). Les clés VAPID sont lues et vérifiées une fois, à la création ; l'en-tête VAPID est gardé par service tant
 * qu'il lui reste plus d'une heure.
 */
function createWebPushTransport(options = {}) {
  const { vapid, ...rest } = options;
  const parsed = parseVapid(vapid);
  readOptions(rest);
  const now = rest.now || Date.now;
  const cache = new Map();
  return async function webPushTransport(subscription, payload, overrides = {}) {
    if (overrides.vapid !== undefined || overrides.vapidDetails !== undefined) throw invalid('the transport signs with the VAPID keys given at creation');
    const opts = { ...rest, ...overrides };
    const body = payload !== null && typeof payload === 'object' && !(payload instanceof Uint8Array) ? JSON.stringify(payload) : payload;
    const request = buildWebPushRequest(subscription, body, opts);
    const url = new URL(request.endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const seconds = Math.floor(now() / 1000);
    let entry = cache.get(audience);
    if (!entry || entry.expiration - seconds < 3600) {
      entry = vapidAuthorization({ audience, vapid: parsed, now });
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(audience, entry);
    }
    request.headers.Authorization = entry.authorization;
    return deliver(request);
  };
}

module.exports = {
  generateVapidKeys,
  vapidAuthorization,
  encryptWebPush,
  decryptWebPush,
  buildWebPushRequest,
  sendWebPush,
  createWebPushTransport,
  WebPushError,
  KNOWN_PUSH_HOSTS,
};
