/**
 * Le contrôle de chaque requête qu'une page fait partir du navigateur.
 *
 * - protocole : `https` (et `wss`) ; `http` (et `ws`) seulement avec
 *   `allowHttp`, et jamais pour la page elle-même ;
 * - port : ceux de `ports` (443 par défaut ; 80 en plus avec `allowHttp`) ;
 * - pas d'identifiants dans l'adresse ;
 * - nom : refusé sans résolution s'il est interne (`localhost`, `*.internal`…,
 *   IP non publique), puis résolu ; si UNE de ses adresses n'est pas publique
 *   (mêmes plages que `isPublicAddress`), la requête est refusée.
 *
 * Le nom est résolu ici, puis encore par Chromium au moment de se connecter :
 * un DNS qui changerait de réponse entre les deux (DNS rebinding) passerait ce
 * contrôle. Seul le pare-feu système, obligatoire en production, couvre ce cas
 * (et WebRTC) : ce contrôle est la deuxième ligne, pas la seule.
 */

const dns = require('dns');
const net = require('net');
const { isPublicAddress, isBlockedHostname } = require('../address');

const SECURE = new Set(['https:', 'wss:']);
const PLAIN = new Set(['http:', 'ws:']);

function lookupAll(resolve, hostname) {
  return new Promise((resolvePromise, reject) => {
    resolve(hostname, { all: true, family: 0 }, (error, addresses) => {
      if (error) return reject(error);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses }]).map((entry) => (typeof entry === 'string' ? entry : entry?.address)).filter(Boolean);
      return resolvePromise(list);
    });
  });
}

/**
 * @param {object} [options]
 * @param {Function} [options.resolve]   dns.lookup (remplaçable dans les tests).
 * @param {number[]} [options.ports]     Défaut [443] (et 80 avec allowHttp).
 * @param {boolean} [options.allowHttp]  Défaut false.
 * @param {number} [options.dnsTtlMs]    Défaut 60 s.
 */
function createRequestGuard(options = {}) {
  const resolve = options.resolve || dns.lookup;
  const allowHttp = options.allowHttp === true;
  const ports = new Set(options.ports || (allowHttp ? [443, 80] : [443]));
  const dnsTtlMs = options.dnsTtlMs ?? 60_000;
  const cache = new Map();

  async function addressesOf(hostname) {
    const cached = cache.get(hostname);
    if (cached && cached.expires > Date.now()) return cached.job;
    const job = lookupAll(resolve, hostname);
    cache.set(hostname, { job, expires: Date.now() + dnsTtlMs });
    job.catch(() => cache.delete(hostname));
    if (cache.size > 2_000) cache.delete(cache.keys().next().value);
    return job;
  }

  /**
   * @param {string} value
   * @param {{ document?: boolean }} [context]  document : la page elle-même (https seulement).
   * @returns {Promise<{ ok: true, url: URL } | { ok: false, reason: string }>}
   */
  async function check(value, context = {}) {
    let url;
    try {
      url = new URL(String(value));
    } catch (_error) {
      return { ok: false, reason: 'invalid_url' };
    }
    const secure = SECURE.has(url.protocol);
    if (!secure && !(PLAIN.has(url.protocol) && allowHttp && !context.document)) return { ok: false, reason: 'protocol' };
    if (url.username || url.password) return { ok: false, reason: 'credentials' };
    const port = url.port ? Number(url.port) : (secure ? 443 : 80);
    if (!ports.has(port)) return { ok: false, reason: 'port' };
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (isBlockedHostname(hostname)) return { ok: false, reason: 'address' };
    if (net.isIP(hostname)) return { ok: true, url };
    let addresses;
    try {
      addresses = await addressesOf(hostname);
    } catch (_error) {
      return { ok: false, reason: 'dns' };
    }
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) return { ok: false, reason: 'address' };
    return { ok: true, url };
  }

  return { check };
}

module.exports = { createRequestGuard };
