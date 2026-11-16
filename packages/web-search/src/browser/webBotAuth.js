/**
 * Web Bot Auth : l'agent prouve son identité en signant ses requêtes
 * (HTTP Message Signatures, RFC 9421, profil Web Bot Auth de l'IETF).
 *
 * - une clé Ed25519 ; son identifiant (`keyid`) est l'empreinte JWK SHA-256
 *   (RFC 7638) de la clé publique ;
 * - l'annuaire de clés à publier à
 *   `/.well-known/http-message-signatures-directory` du domaine choisi
 *   (type `application/http-message-signatures-directory+json`) ;
 * - chaque requête signée porte `Signature-Agent` (l'adresse de l'annuaire),
 *   `Signature-Input` et `Signature`, sur les composants `@authority` et
 *   `signature-agent`, avec `created`, `expires`, `keyid`, `alg`, `nonce` et
 *   `tag="web-bot-auth"`.
 *
 * Désactivée tant qu'aucune clé n'est donnée.
 */

const crypto = require('crypto');
const fs = require('fs');

const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
const DIRECTORY_TYPE = 'application/http-message-signatures-directory+json';

/** Une paire de clés Ed25519, la privée en PEM (PKCS#8). */
function createSigningKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicJwk: publicKey.export({ format: 'jwk' })
  };
}

/** L'empreinte JWK (RFC 7638) d'une clé publique Ed25519, en base64url. */
function jwkThumbprint(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new TypeError('An Ed25519 public JWK is expected.');
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

/** L'annuaire de clés à publier (JSON). */
function signatureDirectory(publicJwks) {
  const keys = (Array.isArray(publicJwks) ? publicJwks : [publicJwks]).map((jwk) => {
    jwkThumbprint(jwk);
    return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  });
  return { keys };
}

/** Une chaîne au format des champs structurés (RFC 8941). */
function sfString(value) {
  const text = String(value);
  if (!/^[\x20-\x7e]*$/.test(text)) throw new TypeError('signature-agent: printable ASCII only.');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Un signataire.
 * @param {object} options
 * @param {string|crypto.KeyObject} options.privateKey   PEM PKCS#8 ou KeyObject Ed25519.
 * @param {string} options.signatureAgent                 l'origine https qui publie l'annuaire de clés.
 * @param {number} [options.validitySeconds]              Défaut 60.
 * @param {Function} [options.now]
 */
function createRequestSigner(options = {}) {
  const key = typeof options.privateKey === 'string' ? crypto.createPrivateKey(options.privateKey) : options.privateKey;
  if (!key || key.asymmetricKeyType !== 'ed25519') throw new TypeError('createRequestSigner needs an Ed25519 private key.');
  let agent;
  try {
    agent = new URL(String(options.signatureAgent || ''));
  } catch (_error) {
    agent = null;
  }
  if (!agent || agent.protocol !== 'https:') throw new TypeError('signatureAgent: the https origin that publishes the key directory.');
  const publicJwk = crypto.createPublicKey(key).export({ format: 'jwk' });
  const keyid = jwkThumbprint(publicJwk);
  const validity = options.validitySeconds ?? 60;
  const now = options.now || Date.now;
  /* Signature-Agent nomme l'origine qui publie l'annuaire (à son chemin .well-known). */
  const agentValue = sfString(agent.origin);

  /**
   * Les en-têtes à ajouter à une requête vers `url`.
   * @returns {{ 'signature-agent': string, 'signature-input': string, signature: string }}
   */
  function sign(url) {
    const target = url instanceof URL ? url : new URL(String(url));
    const created = Math.floor(now() / 1000);
    const nonce = crypto.randomBytes(32).toString('base64');
    const params = `("@authority" "signature-agent");created=${created};expires=${created + validity};keyid=${sfString(keyid)};alg="ed25519";nonce=${sfString(nonce)};tag="web-bot-auth"`;
    const base = [
      `"@authority": ${target.host.toLowerCase()}`,
      `"signature-agent": ${agentValue}`,
      `"@signature-params": ${params}`
    ].join('\n');
    const signature = crypto.sign(null, Buffer.from(base), key).toString('base64');
    return { 'signature-agent': agentValue, 'signature-input': `sig1=${params}`, signature: `sig1=:${signature}:` };
  }

  return { sign, keyid, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x } };
}

/** Le signataire décrit par un fichier de clé, ou null sans fichier. */
function signerFromFile({ signingKeyFile, signatureAgent } = {}) {
  if (!signingKeyFile) return null;
  if (!signatureAgent) throw new TypeError('signatureAgent is required with signingKeyFile.');
  return createRequestSigner({ privateKey: fs.readFileSync(signingKeyFile, 'utf8'), signatureAgent });
}

module.exports = {
  createSigningKey,
  createRequestSigner,
  signerFromFile,
  jwkThumbprint,
  signatureDirectory,
  SIGNATURE_DIRECTORY_PATH: DIRECTORY_PATH,
  SIGNATURE_DIRECTORY_TYPE: DIRECTORY_TYPE
};
