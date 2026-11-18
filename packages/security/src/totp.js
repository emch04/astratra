const crypto = require('node:crypto');

/*
 * La double authentification par code à six chiffres (TOTP, RFC 6238, sur HOTP, RFC 4226), écrite avec node:crypto
 * (elle remplace otplib). Les mêmes codes, les mêmes vérifications et les mêmes adresses otpauth:// qu'otplib 13 sur
 * des vecteurs enregistrés, et les vecteurs des RFC 4226 et 6238.
 *
 * Différences voulues :
 *   - un code mal formé (« abcdef », « 12345 ») est simplement invalide, au lieu de lever une exception ;
 *   - `afterStep` refuse un code déjà servi (le même code rejoué dans sa fenêtre de 30 s) ;
 *   - un émetteur ou un nom de compte contenant « : » est refusé (le format otpauth le sépare par « : ») ;
 *   - tous les pas de la fenêtre sont comparés en temps constant, sans s'arrêter au premier qui correspond.
 * La limite des essais (6 chiffres = un million de codes) reste à la charge de la route : voir createAccountLimiter.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HASHES = { sha1: 'sha1', sha256: 'sha256', sha512: 'sha512' };

class TotpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TotpError';
  }
}

/** Base32 (RFC 4648), en majuscules, sans remplissage. */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 lu sans tenir compte de la casse, des espaces ni du remplissage ; un autre caractère est refusé. */
function base32Decode(text) {
  if (typeof text !== 'string') throw new TotpError('secret must be a base32 string');
  // La longueur d'abord, et le remplissage retiré par une boucle : l'expression « =+$ » s'emballait sur une longue
  // suite de « = » (trouvé par assertSafeRegex).
  if (text.length > 1024) throw new TotpError('secret too long');
  let clean = text.replace(/[\s-]/g, '');
  let end = clean.length;
  while (end > 0 && clean[end - 1] === '=') end -= 1;
  clean = clean.slice(0, end).toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new TotpError('secret is not valid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const keyOf = (secret) => {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  if (key.length < 10) throw new TotpError('secret must be at least 80 bits (RFC 4226)');
  return key;
};

const optionsOf = ({ digits = 6, algorithm = 'sha1', period = 30 } = {}) => {
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new TotpError('digits must be between 6 and 10');
  if (!HASHES[algorithm]) throw new TotpError('algorithm must be sha1, sha256 or sha512');
  if (!Number.isInteger(period) || period < 1 || period > 3600) throw new TotpError('period must be a number of seconds');
  return { digits, algorithm, period };
};

/** Un secret neuf (20 octets, en base32 : 32 caractères), comme otplib. */
function generateTotpSecret({ bytes = 20 } = {}) {
  if (!Number.isInteger(bytes) || bytes < 10 || bytes > 64) throw new TotpError('bytes must be between 10 and 64');
  return base32Encode(crypto.randomBytes(bytes));
}

/** Le code HOTP (RFC 4226) d'un compteur. */
function hotp(secret, counter, options = {}) {
  const { digits, algorithm } = optionsOf(options);
  if (!Number.isSafeInteger(counter) || counter < 0) throw new TotpError('counter must be a non-negative integer');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(HASHES[algorithm], keyOf(secret)).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/** Le code TOTP (RFC 6238) d'un instant (`epoch` en secondes, maintenant par défaut). */
function totp(secret, { epoch = Math.floor(Date.now() / 1000), ...options } = {}) {
  const { period } = optionsOf(options);
  return hotp(secret, Math.floor(epoch / period), options);
}

/**
 * Vérifie un code. `epochTolerance` (secondes, 30 par défaut : un pas avant ou après) couvre le décalage d'horloge du
 * téléphone ; `afterStep` refuse un pas déjà servi (gardez `timeStep` du dernier code accepté). Rend
 * { valid, delta, timeStep, epoch } ; un code mal formé est invalide, sans exception.
 */
function verifyTotp({ secret, token, epoch = Math.floor(Date.now() / 1000), epochTolerance = 30, afterStep, ...options } = {}) {
  const { digits, period } = optionsOf(options);
  const key = keyOf(secret);
  if (typeof token !== 'string' || token.length !== digits || !/^\d+$/.test(token)) return { valid: false, reason: 'format' };
  if (!Number.isFinite(epochTolerance) || epochTolerance < 0 || epochTolerance > 10 * period) throw new TotpError('epochTolerance must be between 0 and 10 periods');
  const current = Math.floor(epoch / period);
  const first = Math.floor((epoch - epochTolerance) / period);
  const last = Math.floor((epoch + epochTolerance) / period);
  const given = Buffer.from(token);
  let matched = null;
  // Chaque pas de la fenêtre est comparé, même après une correspondance : le temps ne dit pas lequel a servi.
  for (let step = first; step <= last; step++) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step, options));
    if (crypto.timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  if (matched === null) return { valid: false, reason: 'mismatch' };
  if (afterStep !== undefined && afterStep !== null && matched <= afterStep) return { valid: false, reason: 'replay', timeStep: matched };
  return { valid: true, delta: matched - current, timeStep: matched, epoch };
}

/** L'adresse otpauth:// à montrer en QR code (format des applications d'authentification). */
function totpUri({ issuer, label, secret, digits = 6, algorithm = 'sha1', period = 30 }) {
  optionsOf({ digits, algorithm, period });
  for (const [name, value] of [['issuer', issuer], ['label', label]]) {
    if (typeof value !== 'string' || !value || value.length > 256) throw new TotpError(`${name} must be a non-empty string`);
    if (value.includes(':')) throw new TotpError(`${name} must not contain ":" (it separates issuer and account in otpauth URIs)`);
  }
  keyOf(secret);
  const extra = [];
  extra.push(`secret=${typeof secret === 'string' ? secret.replace(/[\s=-]/g, '').toUpperCase() : base32Encode(secret)}`);
  extra.push(`issuer=${encodeURIComponent(issuer)}`);
  if (algorithm !== 'sha1') extra.push(`algorithm=${algorithm.toUpperCase()}`);
  if (digits !== 6) extra.push(`digits=${digits}`);
  if (period !== 30) extra.push(`period=${period}`);
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${extra.join('&')}`;
}

module.exports = { generateTotpSecret, totp, hotp, verifyTotp, totpUri, base32Encode, base32Decode, TotpError };
