/* global AbortSignal */
const crypto = require('node:crypto');
const { URLSearchParams } = require('node:url');

/*
 * Le jeton d'accès d'un compte de service Google, sans google-auth-library : un JWT signé en RS256 avec la clé du
 * compte, échangé contre un jeton d'accès (RFC 7523, « jwt-bearer »). Une seule écriture pour tous les paquets
 * (Google Wallet, Google Play, Firebase…), au lieu d'une copie par projet.
 *
 * - Le jeton est gardé jusqu'à cinq minutes avant son échéance ; des demandes simultanées partagent un seul échange.
 * - L'adresse d'échange (token_uri) n'est acceptée que chez Google, en https : un fichier de compte de service modifié
 *   ne peut pas envoyer l'assertion signée (valable une heure chez Google) à un autre serveur.
 * - Aucun message d'erreur ne reprend la clé, l'assertion ou le jeton.
 */

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const ASSERTION_LIFETIME_SECONDS = 3600;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

class GoogleAuthError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'GoogleAuthError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** Une adresse d'échange permise : https, sur googleapis.com (ou un de ses sous-domaines), sans identifiants. */
function isGoogleTokenUri(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'googleapis.com' || url.hostname.endsWith('.googleapis.com')) && (url.port === '' || url.port === '443');
}

/** Le compte de service lu (objet, ou texte JSON), vérifié ; la clé privée devient un KeyObject RSA. */
function readServiceAccount(credentials, { allowedTokenUris } = {}) {
  let account = credentials;
  if (typeof account === 'string') {
    try {
      account = JSON.parse(account);
    } catch {
      throw new GoogleAuthError('GOOGLE_CREDENTIALS_INVALID', 'Google service account credentials are not valid JSON.');
    }
  }
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    throw new GoogleAuthError('GOOGLE_CREDENTIALS_INVALID', 'Google service account credentials must be an object.');
  }
  const clientEmail = account.client_email;
  if (typeof clientEmail !== 'string' || !/^[^\s@]{1,128}@[^\s@]{1,253}$/.test(clientEmail)) {
    throw new GoogleAuthError('GOOGLE_CREDENTIALS_INVALID', 'Google service account credentials need a client_email.');
  }
  if (typeof account.private_key !== 'string' || !account.private_key.includes('PRIVATE KEY')) {
    throw new GoogleAuthError('GOOGLE_CREDENTIALS_INVALID', 'Google service account credentials need a PEM private_key.');
  }
  let privateKey;
  try {
    // Collée dans une variable d'environnement d'une ligne, la clé garde souvent ses « \n » écrits en toutes lettres.
    privateKey = crypto.createPrivateKey(account.private_key.replace(/\\n/g, '\n'));
  } catch {
    throw new GoogleAuthError('GOOGLE_CREDENTIALS_INVALID', 'The private_key of the Google service account cannot be read.');
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new GoogleAuthError('GOOGLE_CREDENTIALS_INVALID', `A Google service account key is RSA (got ${privateKey.asymmetricKeyType}).`);
  }
  const tokenUri = account.token_uri === undefined || account.token_uri === null || account.token_uri === '' ? DEFAULT_TOKEN_URI : account.token_uri;
  const permitted = allowedTokenUris ? allowedTokenUris.includes(tokenUri) : isGoogleTokenUri(tokenUri);
  if (!permitted) {
    throw new GoogleAuthError('GOOGLE_TOKEN_URI_REFUSED', 'The token_uri of the Google service account is not a Google address (https on googleapis.com).');
  }
  return { clientEmail, privateKey, tokenUri, projectId: typeof account.project_id === 'string' ? account.project_id : undefined };
}

const base64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** L'assertion signée (RS256) que Google échange contre un jeton d'accès. */
function signServiceAccountAssertion(account, { scopes, subject, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const header = base64urlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = base64urlJson({
    iss: account.clientEmail,
    scope: scopes.join(' '),
    aud: account.tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
    ...(subject ? { sub: subject } : {}),
  });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), account.privateKey).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

/**
 * @param {object} options
 * @param {object|string} options.credentials  le JSON du compte de service (client_email, private_key, token_uri…).
 * @param {string[]} options.scopes             les portées demandées (au moins une).
 * @param {string} [options.subject]            un compte à emprunter (délégation à l'échelle du domaine).
 * @param {Function} [options.fetch]            remplace fetch (essais).
 * @param {() => number} [options.now]          l'heure en millisecondes (essais).
 * @param {number} [options.timeoutMs]          délai de chaque appel à Google (15 s).
 * @param {string[]} [options.allowedTokenUris] adresses d'échange permises à la place de googleapis.com (essais, émulateur).
 */
function createGoogleServiceAccountAuth({ credentials, scopes, subject, fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, allowedTokenUris } = {}) {
  const account = readServiceAccount(credentials, { allowedTokenUris });
  if (!Array.isArray(scopes) || !scopes.length || !scopes.every((s) => typeof s === 'string' && /^https:\/\/\S+$/.test(s))) {
    throw new GoogleAuthError('GOOGLE_SCOPES_INVALID', 'createGoogleServiceAccountAuth needs one or more https:// scopes.');
  }
  if (typeof fetchImpl !== 'function') throw new GoogleAuthError('GOOGLE_NO_FETCH', 'No fetch implementation available.');

  let cached = null;
  let pending = null;

  const send = async (url, init) => {
    try {
      return await fetchImpl(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const reason = error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timed out' : error && error.code ? error.code : 'network error';
      throw new GoogleAuthError('GOOGLE_UNREACHABLE', `Google could not be reached (${reason}).`, 502);
    }
  };

  async function exchange() {
    const assertion = signServiceAccountAssertion(account, { scopes, subject, nowSeconds: Math.floor(now() / 1000) });
    const response = await send(account.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      // Le code d'erreur OAuth (« invalid_grant »…) aide à comprendre ; le reste de la réponse n'est pas repris.
      const reason = body && typeof body.error === 'string' && /^[\w.-]{1,64}$/.test(body.error) ? `: ${body.error}` : '';
      const refused = new GoogleAuthError('GOOGLE_TOKEN_REFUSED', `Google refused the service account (${response.status}${reason}).`, response.status === 400 || response.status === 401 ? 401 : 502);
      refused.httpStatus = response.status;
      throw refused;
    }
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      throw new GoogleAuthError('GOOGLE_TOKEN_REFUSED', 'Google returned no access token.', 502);
    }
    const lifetime = Number(body.expires_in);
    const seconds = Number.isFinite(lifetime) && lifetime > 0 ? Math.min(lifetime, ASSERTION_LIFETIME_SECONDS) : ASSERTION_LIFETIME_SECONDS;
    cached = { token: body.access_token, expiresAt: now() + seconds * 1000 };
    return cached.token;
  }

  /** Le jeton d'accès, gardé jusqu'à cinq minutes avant son échéance ; un seul échange à la fois. */
  async function getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.token;
    if (!pending) pending = exchange().finally(() => { pending = null; });
    return pending;
  }

  /**
   * Un appel JSON à une API Google avec le jeton. Rend { status, data, headers } ; une réponse d'erreur lève une
   * GoogleAuthError GOOGLE_API_ERROR avec `response = { status, data }` (comme le client de google-auth-library). Un 401
   * fait renouveler le jeton et rejouer l'appel une seule fois.
   */
  async function request({ method = 'GET', url, data, headers = {}, signal } = {}) {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new GoogleAuthError('GOOGLE_URL_INVALID', 'request() needs an https:// url.');
    const call = async (token) =>
      send(url, {
        method,
        signal,
        headers: { accept: 'application/json', ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers, authorization: `Bearer ${token}` },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      });
    let response = await call(await getAccessToken());
    if (response.status === 401) response = await call(await getAccessToken({ forceRefresh: true }));
    const text = await response.text().catch(() => '');
    let body = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const error = new GoogleAuthError('GOOGLE_API_ERROR', `Google API answered ${response.status} for ${method} ${new URL(url).pathname}.`, response.status);
      error.response = { status: response.status, data: body };
      throw error;
    }
    return { status: response.status, data: body, headers: response.headers };
  }

  return { getAccessToken, request, clientEmail: account.clientEmail, projectId: account.projectId };
}

module.exports = { createGoogleServiceAccountAuth, signServiceAccountAssertion, readGoogleServiceAccount: readServiceAccount, isGoogleTokenUri, GoogleAuthError, GOOGLE_TOKEN_URI: DEFAULT_TOKEN_URI };
