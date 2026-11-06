/**
 * Les erreurs du paquet : un code stable, un message court, jamais de clé.
 *
 * Le message d'une erreur part parfois vers un modèle ou un journal : il ne
 * porte que le code, le fournisseur et le statut HTTP. Une clé passée par
 * l'appelant est aussi retirée de tout texte venu d'ailleurs (`redact`).
 */

const CODES = Object.freeze({
  BAD_REQUEST: 'WEB_SEARCH_BAD_REQUEST',
  NO_PROVIDER: 'WEB_SEARCH_NO_PROVIDER',
  ALL_FAILED: 'WEB_SEARCH_ALL_FAILED',
  PROVIDER_FAILED: 'WEB_SEARCH_PROVIDER_FAILED',
  QUOTA: 'WEB_SEARCH_QUOTA',
  BLOCKED_URL: 'WEB_READ_BLOCKED_URL',
  BLOCKED_ADDRESS: 'WEB_READ_BLOCKED_ADDRESS',
  TOO_MANY_REDIRECTS: 'WEB_READ_TOO_MANY_REDIRECTS',
  TOO_LARGE: 'WEB_READ_TOO_LARGE',
  TIMEOUT: 'WEB_READ_TIMEOUT',
  BAD_STATUS: 'WEB_READ_BAD_STATUS',
  UNSUPPORTED_TYPE: 'WEB_READ_UNSUPPORTED_TYPE',
  READ_FAILED: 'WEB_READ_FAILED'
});

class WebSearchError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ provider?: string, status?: number, retryable?: boolean, quota?: boolean }} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WebSearchError';
    this.code = code;
    if (details.provider) this.provider = details.provider;
    if (details.status !== undefined) this.status = details.status;
    this.retryable = Boolean(details.retryable);
    this.quota = Boolean(details.quota);
  }
}

/** Retire chaque secret d'un texte (au moins 4 caractères, pour ne pas effacer n'importe quoi). */
function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * L'échec d'un fournisseur, classé pour le repli :
 * - 429, 5xx, réseau, délai : `retryable` (un nouvel essai a une chance) ;
 * - 402, 429 répété, quota : `quota` (passer au suivant, le laisser reposer) ;
 * - autre 4xx : ni l'un ni l'autre (la requête elle-même est refusée par ce moteur).
 */
function providerFailure(provider, { status, cause, secrets } = {}) {
  const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
  const quota = status === 402 || status === 429;
  const reason = status !== undefined ? `answered ${status}` : `unreachable (${redact(cause?.name === 'TimeoutError' || cause?.name === 'AbortError' ? 'timeout' : cause?.message || 'network', secrets).slice(0, 120)})`;
  return new WebSearchError(CODES.PROVIDER_FAILED, `${provider} ${reason}`, { provider, status, retryable, quota });
}

module.exports = { CODES, WebSearchError, redact, providerFailure };
