/**
 * L'appel HTTP d'un fournisseur de recherche : délai, classement de l'échec
 * pour le repli, et jamais la clé dans une erreur.
 */

const { providerFailure, redact } = require('../errors');

const DEFAULT_TIMEOUT_MS = 10_000;

/** Le signal de l'appel : celui de l'appelant ET le délai. */
function callSignal(signal, timeoutMs) {
  const timeout = globalThis.AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS);
  return signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * @param {string} provider
 * @param {object} io
 * @param {Function} io.fetch
 * @param {string} io.url
 * @param {object} io.init     méthode, en-têtes, corps
 * @param {string[]} io.secrets ce qui ne doit paraître dans aucune erreur
 * @param {AbortSignal} [io.signal]
 * @param {number} [io.timeoutMs]
 */
async function requestJson(provider, { fetch, url, init, secrets, signal, timeoutMs }) {
  if (typeof fetch !== 'function') throw new Error(`${provider}: no fetch available (Node 20 or io.fetch).`);
  let response;
  try {
    response = await fetch(url, { ...init, signal: callSignal(signal, timeoutMs) });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw providerFailure(provider, { cause: error, secrets });
  }
  if (!response.ok) throw providerFailure(provider, { status: response.status, secrets });
  try {
    return await response.json();
  } catch (error) {
    const failure = providerFailure(provider, { cause: { message: `invalid JSON: ${redact(error.message, secrets)}` }, secrets });
    failure.retryable = false;
    throw failure;
  }
}

/** La clé : une valeur, ou une fonction lue à chaque appel (rotation sans redémarrage). */
async function readKey(key) {
  const value = typeof key === 'function' ? await key() : key;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

module.exports = { requestJson, readKey, callSignal, DEFAULT_TIMEOUT_MS };
