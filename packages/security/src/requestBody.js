/**
 * La requête annonce-t-elle un corps ?
 *
 * Express 4 donnait toujours un objet à req.body dès qu'un analyseur
 * (express.json…) était monté, même pour un GET. Express 5 le laisse à
 * undefined quand la requête n'a pas de corps. « req.body est undefined » ne
 * prouve donc un mauvais ordre de montage que si un corps a été envoyé.
 */
function hasRequestBody(req) {
  const headers = req && req.headers;
  if (!headers) return false;
  if (headers['transfer-encoding'] !== undefined) return true;
  const length = Number(headers['content-length']);
  return Number.isFinite(length) && length > 0;
}

/** Corps envoyé mais jamais lu par un analyseur monté plus tôt. */
const bodyLeftUnparsed = (req) => req.body === undefined && hasRequestBody(req);

module.exports = { hasRequestBody, bodyLeftUnparsed };
