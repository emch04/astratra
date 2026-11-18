const crypto = require('node:crypto');

/*
 * La signature AWS version 4 (SigV4) des requêtes S3, en en-tête (Authorization) ou dans l'adresse (lien signé).
 * Écrite d'après la documentation d'AWS ; mêmes signatures que @smithy/signature-v4 (le signataire du SDK AWS v3)
 * sur des vecteurs enregistrés, et les exemples S3 de la documentation d'AWS.
 *
 * Particularités de S3 (différentes des autres services AWS) : le chemin n'est encodé qu'une fois et n'est jamais
 * normalisé (« a/../b » reste tel quel) ; le hachage du corps va dans l'en-tête x-amz-content-sha256.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
// Jamais signés : ils peuvent changer en route (mandataires, agents HTTP) sans que la requête change de sens.
const UNSIGNABLE = new Set(['authorization', 'user-agent', 'x-amzn-trace-id', 'expect', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'cache-control', 'pragma', 'referer', 'from', 'max-forwards']);

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 : seuls A-Z a-z 0-9 - . _ ~ restent tels quels, le reste en %XX majuscules (octets UTF-8). */
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Le chemin d'un objet : chaque segment encodé, les « / » gardés. */
const encodePath = (path) => path.split('/').map(encodeRfc3986).join('/');

/** « 20260518T093000Z » et « 20260518 ». */
function amzDate(date) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { stamp: iso, day: iso.slice(0, 8) };
}

function canonicalQuery(query) {
  return Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(String(v))])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Les en-têtes signés : noms en minuscules, valeurs sans espaces en trop, triés. */
function canonicalHeaders(headers) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/ {2,}/g, ' ')])
    .filter(([name]) => !UNSIGNABLE.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { text: entries.map(([n, v]) => `${n}:${v}\n`).join(''), signed: entries.map(([n]) => n).join(';') };
}

const signingKeys = new Map();
function signingKey(secret, day, region, service) {
  const id = `${sha256Hex(secret)}|${day}|${region}|${service}`;
  let key = signingKeys.get(id);
  if (!key) {
    key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
    if (signingKeys.size >= 50) signingKeys.delete(signingKeys.keys().next().value);
    signingKeys.set(id, key);
  }
  return key;
}

function stringToSign({ method, path, query, headers, payloadHash, scope, stamp }) {
  const { text, signed } = canonicalHeaders(headers);
  const canonical = [method, path, canonicalQuery(query), text, signed, payloadHash].join('\n');
  return { toSign: [ALGORITHM, stamp, scope, sha256Hex(canonical)].join('\n'), signed, canonical };
}

/**
 * Signe une requête en en-tête. `path` est déjà encodé (encodePath) ; `headers` doit contenir host. Rend les
 * en-têtes à envoyer : ceux donnés, plus x-amz-date, x-amz-content-sha256, x-amz-security-token et authorization.
 */
function signRequest({ method, path, query = {}, headers, payloadHash = EMPTY_SHA256, region, service = 's3', credentials, date = new Date() }) {
  const { stamp, day } = amzDate(date);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const all = { ...headers, 'x-amz-date': stamp, 'x-amz-content-sha256': payloadHash };
  if (credentials.sessionToken) all['x-amz-security-token'] = credentials.sessionToken;
  const { toSign, signed } = stringToSign({ method, path, query, headers: all, payloadHash, scope, stamp });
  const signature = hmac(signingKey(credentials.secretAccessKey, day, region, service), toSign).toString('hex');
  return { ...all, authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}

/**
 * Signe une adresse (lien signé) : rend la chaîne de requête complète, X-Amz-Signature compris. `headers` : host et
 * les en-têtes que le navigateur devra envoyer à l'identique (content-type d'un dépôt, par exemple).
 */
function presignQuery({ method, path, query = {}, headers, region, service = 's3', credentials, date = new Date(), expiresIn, contentSha256Param = true }) {
  const { stamp, day } = amzDate(date);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const { signed } = canonicalHeaders(headers);
  const full = {
    ...query,
    'X-Amz-Algorithm': ALGORITHM,
    // Le SDK AWS v3 met ce paramètre (facultatif pour S3) ; l'exemple de la documentation d'AWS ne l'a pas.
    ...(contentSha256Param ? { 'X-Amz-Content-Sha256': UNSIGNED_PAYLOAD } : {}),
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expiresIn),
    ...(credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}),
    'X-Amz-SignedHeaders': signed,
  };
  const { toSign } = stringToSign({ method, path, query: full, headers, payloadHash: UNSIGNED_PAYLOAD, scope, stamp });
  const signature = hmac(signingKey(credentials.secretAccessKey, day, region, service), toSign).toString('hex');
  return `${canonicalQuery(full)}&X-Amz-Signature=${signature}`;
}

module.exports = { signRequest, presignQuery, encodeRfc3986, encodePath, canonicalQuery, sha256Hex, amzDate, UNSIGNED_PAYLOAD, EMPTY_SHA256 };
