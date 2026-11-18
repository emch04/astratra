const crypto = require('node:crypto');

/*
 * Les jetons JWT (RFC 7519) signés en JWS compact (RFC 7515), écrits ici avec node:crypto (ils remplacent
 * jsonwebtoken). Même forme de jeton, mêmes revendications, mêmes noms d'erreur (JsonWebTokenError, TokenExpiredError,
 * NotBeforeError) : comparé à jsonwebtoken 9 sur des centaines de vecteurs enregistrés avant son retrait.
 *
 * Plus strict là où c'est sans regret :
 *   - la liste des algorithmes est obligatoire à la vérification, et « none » n'existe pas ;
 *   - une clé ne sert qu'à sa famille : un secret HMAC ne peut pas être une clé publique (confusion d'algorithme), une
 *     clé EC doit être de la courbe de l'algorithme, une clé RSA d'au moins 2 048 bits ;
 *   - chaque morceau doit être du base64url exact (pas de remplissage, pas d'autre alphabet), la signature HMAC est
 *     comparée en temps constant, un en-tête « crit » est refusé (aucune extension n'est comprise) ;
 *   - la charge doit être un objet JSON, et le jeton ne dépasse pas `maxTokenLength` (16 Kio par défaut) ;
 *   - toute entrée abîmée est refusée par une JsonWebTokenError, jamais par une autre exception.
 */

class JsonWebTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonWebTokenError';
  }
}
class TokenExpiredError extends JsonWebTokenError {
  constructor(message, expiredAt) {
    super(message);
    this.name = 'TokenExpiredError';
    this.expiredAt = expiredAt;
  }
}
class NotBeforeError extends JsonWebTokenError {
  constructor(message, date) {
    super(message);
    this.name = 'NotBeforeError';
    this.date = date;
  }
}

const HASH = { 256: 'sha256', 384: 'sha384', 512: 'sha512' };
const EC_CURVE = { ES256: 'prime256v1', ES384: 'secp384r1', ES512: 'secp521r1' };
const EC_SIGNATURE_LENGTH = { ES256: 64, ES384: 96, ES512: 132 };
const ALGORITHMS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
const DEFAULT_MAX_TOKEN_LENGTH = 16 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

const family = (alg) => alg.slice(0, 2);
const hashOf = (alg) => HASH[alg.slice(2)];

/* Les durées écrites comme jsonwebtoken les lisait (module ms) : un nombre de secondes, ou un texte « 15m », « 2 days »,
   « 1.5h » ; un texte sans unité compte en millisecondes. */
const UNITS = {
  ms: 1, msec: 1, msecs: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  y: 31_557_600_000, yr: 31_557_600_000, yrs: 31_557_600_000, year: 31_557_600_000, years: 31_557_600_000,
};
function timespan(value, timestamp) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(timestamp + value);
  if (typeof value === 'string' && value.length <= 100) {
    // Sans ambiguïté : les chiffres avant la virgule ne peuvent être pris que d'une façon. L'expression du module ms
    // (« (?:\d+)?\.?\d+ ») s'emballait sur une longue suite de chiffres (trouvé par assertSafeRegex).
    const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+)) *([a-z]+)?$/i.exec(value);
    if (match) {
      const unit = UNITS[(match[2] || 'ms').toLowerCase()];
      if (unit) return Math.floor(timestamp + (Number(match[1]) * unit) / 1000);
    }
  }
  return undefined;
}

const encodeJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Une partie base64url exacte, décodée ; null si elle ne l'est pas (remplissage, autre alphabet, écriture non canonique). */
function decodeSegment(segment) {
  if (typeof segment !== 'string' || !BASE64URL.test(segment) || segment.length % 4 === 1) return null;
  const bytes = Buffer.from(segment, 'base64url');
  return bytes.toString('base64url') === segment ? bytes : null;
}

function parseJsonSegment(segment) {
  const bytes = decodeSegment(segment);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Le jeton découpé sans rien vérifier ({ header, payload, signature }), ou null. */
function decodeJwt(token, { complete = false } = {}) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = parseJsonSegment(parts[0]);
  const payload = parseJsonSegment(parts[1]);
  if (!header || typeof header !== 'object' || Array.isArray(header) || payload === undefined) return null;
  return complete ? { header, payload, signature: parts[2] } : payload;
}

const looksLikePem = (text) => /-----BEGIN [A-Z ]*KEY-----/.test(text) || /-----BEGIN CERTIFICATE-----/.test(text);

/** La clé pour l'algorithme, vérifiée : une clé d'une autre famille est refusée (pas de confusion d'algorithme). */
function keyFor(alg, key, usage) {
  if (family(alg) === 'HS') {
    if (key && typeof key === 'object' && typeof key.type === 'string' && !Buffer.isBuffer(key)) {
      if (key.type !== 'secret') throw new JsonWebTokenError(`secretOrPublicKey must be a symmetric key when using ${alg}`);
      return key;
    }
    if (typeof key === 'string' && looksLikePem(key)) throw new JsonWebTokenError(`secretOrPublicKey must be a symmetric key when using ${alg}`);
    if ((typeof key !== 'string' && !Buffer.isBuffer(key)) || key.length === 0) throw new JsonWebTokenError('secret or public key must be provided');
    return crypto.createSecretKey(Buffer.isBuffer(key) ? key : Buffer.from(key, 'utf8'));
  }
  let keyObject;
  try {
    if (key && typeof key === 'object' && typeof key.type === 'string' && !Buffer.isBuffer(key)) keyObject = key;
    else if (usage === 'sign') keyObject = crypto.createPrivateKey(key);
    else keyObject = crypto.createPublicKey(key);
  } catch {
    throw new JsonWebTokenError(`the key cannot be read for ${alg}`);
  }
  if (keyObject.type === 'secret') throw new JsonWebTokenError(`a symmetric key cannot be used for ${alg}`);
  if (usage === 'sign' && keyObject.type !== 'private') throw new JsonWebTokenError(`a private key is needed to sign with ${alg}`);
  if (usage === 'verify' && keyObject.type === 'private') keyObject = crypto.createPublicKey(keyObject);
  const type = keyObject.asymmetricKeyType;
  if (family(alg) === 'ES') {
    if (type !== 'ec' || keyObject.asymmetricKeyDetails.namedCurve !== EC_CURVE[alg]) throw new JsonWebTokenError(`"alg" parameter "${alg}" requires curve "${EC_CURVE[alg]}"`);
  } else {
    if (type !== 'rsa' && !(family(alg) === 'PS' && type === 'rsa-pss')) throw new JsonWebTokenError(`"alg" parameter for "${type}" key type must be one of: ${type === 'ec' ? 'ES256, ES384, ES512' : 'RS256, RS384, RS512, PS256, PS384, PS512'}.`);
    if (keyObject.asymmetricKeyDetails.modulusLength < 2048) throw new JsonWebTokenError(`${alg} requires a key size of 2048 bits or larger`);
  }
  return keyObject;
}

function signatureOf(alg, input, key) {
  const hash = hashOf(alg);
  if (family(alg) === 'HS') return crypto.createHmac(hash, key).update(input).digest();
  if (family(alg) === 'ES') return crypto.sign(hash, Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  if (family(alg) === 'PS') return crypto.sign(hash, Buffer.from(input), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  return crypto.sign(hash, Buffer.from(input), key);
}

function signatureMatches(alg, input, signature, key) {
  const hash = hashOf(alg);
  if (family(alg) === 'HS') {
    const expected = crypto.createHmac(hash, key).update(input).digest();
    return signature.length === expected.length && crypto.timingSafeEqual(signature, expected);
  }
  try {
    if (family(alg) === 'ES') {
      if (signature.length !== EC_SIGNATURE_LENGTH[alg]) return false;
      return crypto.verify(hash, Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    if (family(alg) === 'PS') return crypto.verify(hash, Buffer.from(input), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, signature);
    return crypto.verify(hash, Buffer.from(input), key, signature);
  } catch {
    return false;
  }
}

const CLAIM_OPTIONS = { audience: 'aud', issuer: 'iss', subject: 'sub', jwtid: 'jti' };

/**
 * Signe un jeton. Options : algorithm (HS256 par défaut), expiresIn, notBefore, audience, issuer, subject, jwtid,
 * keyid, header, noTimestamp. Une revendication donnée deux fois (dans la charge et en option) est refusée.
 */
function signJwt(payload, key, options = {}) {
  const alg = options.algorithm || 'HS256';
  if (!ALGORITHMS.includes(alg)) throw new JsonWebTokenError('"algorithm" must be a valid string enum value');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new JsonWebTokenError('payload must be a plain object');
  const claims = { ...payload };
  const timestamp = typeof claims.iat === 'number' ? claims.iat : Math.floor(Date.now() / 1000);
  if (options.noTimestamp) delete claims.iat;
  else claims.iat = timestamp;
  if (options.notBefore !== undefined) {
    if (claims.nbf !== undefined) throw new JsonWebTokenError('Bad "options.notBefore" option the payload already has an "nbf" property.');
    claims.nbf = timespan(options.notBefore, timestamp);
    if (claims.nbf === undefined) throw new JsonWebTokenError('"notBefore" should be a number of seconds or string representing a timespan eg: "1d", "20h", 60');
  }
  if (options.expiresIn !== undefined) {
    if (claims.exp !== undefined) throw new JsonWebTokenError('Bad "options.expiresIn" option the payload already has an "exp" property.');
    claims.exp = timespan(options.expiresIn, timestamp);
    if (claims.exp === undefined) throw new JsonWebTokenError('"expiresIn" should be a number of seconds or string representing a timespan eg: "1d", "20h", 60');
  }
  for (const [option, claim] of Object.entries(CLAIM_OPTIONS)) {
    if (options[option] === undefined) continue;
    if (claims[claim] !== undefined) throw new JsonWebTokenError(`Bad "options.${option}" option. The payload already has an "${claim}" property.`);
    claims[claim] = options[option];
  }
  const header = { alg, typ: 'JWT', ...(options.keyid !== undefined ? { kid: options.keyid } : {}), ...(options.header || {}) };
  header.alg = alg;
  const input = `${encodeJson(header)}.${encodeJson(claims)}`;
  return `${input}.${signatureOf(alg, input, keyFor(alg, key, 'sign')).toString('base64url')}`;
}

/**
 * Vérifie un jeton et rend sa charge. Options : algorithms (obligatoire), issuer (texte ou liste), audience (texte,
 * expression ou liste), subject, jwtid, clockTolerance (secondes), clockTimestamp, maxAge, maxTokenLength, complete.
 */
function verifyJwt(token, key, options = {}) {
  const algorithms = options.algorithms;
  if (!Array.isArray(algorithms) || !algorithms.length || !algorithms.every((a) => ALGORITHMS.includes(a))) {
    throw new JsonWebTokenError('verifyJwt needs options.algorithms (one or more of ' + ALGORITHMS.join(', ') + ')');
  }
  if (typeof token !== 'string' || !token) throw new JsonWebTokenError('jwt must be provided');
  if (token.length > (options.maxTokenLength || DEFAULT_MAX_TOKEN_LENGTH)) throw new JsonWebTokenError('jwt too long');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JsonWebTokenError('jwt malformed');
  const header = parseJsonSegment(parts[0]);
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new JsonWebTokenError('invalid token');
  if (header.crit !== undefined) throw new JsonWebTokenError('unsupported critical header');
  if (typeof header.alg !== 'string' || !algorithms.includes(header.alg)) throw new JsonWebTokenError('invalid algorithm');
  if (!parts[2]) throw new JsonWebTokenError('jwt signature is required');
  const signature = decodeSegment(parts[2]);
  if (!signature) throw new JsonWebTokenError('invalid signature');
  const verificationKey = keyFor(header.alg, key, 'verify');
  if (!signatureMatches(header.alg, `${parts[0]}.${parts[1]}`, signature, verificationKey)) throw new JsonWebTokenError('invalid signature');

  const payload = parseJsonSegment(parts[1]);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new JsonWebTokenError('invalid token');
  const now = options.clockTimestamp !== undefined ? options.clockTimestamp : Math.floor(Date.now() / 1000);
  const tolerance = options.clockTolerance || 0;

  if (payload.nbf !== undefined && !options.ignoreNotBefore) {
    if (typeof payload.nbf !== 'number') throw new JsonWebTokenError('invalid nbf value');
    if (payload.nbf > now + tolerance) throw new NotBeforeError('jwt not active', new Date(payload.nbf * 1000));
  }
  if (payload.exp !== undefined && !options.ignoreExpiration) {
    if (typeof payload.exp !== 'number') throw new JsonWebTokenError('invalid exp value');
    if (now >= payload.exp + tolerance) throw new TokenExpiredError('jwt expired', new Date(payload.exp * 1000));
  }
  if (options.audience !== undefined) {
    const wanted = Array.isArray(options.audience) ? options.audience : [options.audience];
    const given = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const match = given.some((aud) => wanted.some((w) => (w instanceof RegExp ? typeof aud === 'string' && w.test(aud) : w === aud)));
    if (!match) throw new JsonWebTokenError(`jwt audience invalid. expected: ${wanted.join(' or ')}`);
  }
  if (options.issuer !== undefined) {
    const wanted = Array.isArray(options.issuer) ? options.issuer : [options.issuer];
    if (typeof payload.iss !== 'string' || !wanted.includes(payload.iss)) throw new JsonWebTokenError(`jwt issuer invalid. expected: ${wanted.join(',')}`);
  }
  if (options.subject !== undefined && payload.sub !== options.subject) throw new JsonWebTokenError(`jwt subject invalid. expected: ${options.subject}`);
  if (options.jwtid !== undefined && payload.jti !== options.jwtid) throw new JsonWebTokenError(`jwt jwtid invalid. expected: ${options.jwtid}`);
  if (options.maxAge !== undefined) {
    if (typeof payload.iat !== 'number') throw new JsonWebTokenError('iat required when maxAge is specified');
    const limit = timespan(options.maxAge, payload.iat);
    if (limit === undefined) throw new JsonWebTokenError('"maxAge" should be a number of seconds or string representing a timespan eg: "1d", "20h", 60');
    if (now >= limit + tolerance) throw new TokenExpiredError('maxAge exceeded', new Date(limit * 1000));
  }
  return options.complete ? { header, payload, signature: parts[2] } : payload;
}

module.exports = { signJwt, verifyJwt, decodeJwt, JsonWebTokenError, TokenExpiredError, NotBeforeError, JWT_ALGORITHMS: ALGORITHMS };
