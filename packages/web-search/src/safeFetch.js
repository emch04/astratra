/**
 * Lire une page du web sans ouvrir de porte vers le réseau interne (SSRF).
 *
 * - https seulement, sur le port 443 (ou ceux que l'appelant autorise), sans
 *   identifiants dans l'adresse ;
 * - le nom est résolu AVANT la connexion, et la connexion part vers l'adresse
 *   vérifiée elle-même (la résolution passe par `lookup` de https.request) :
 *   un DNS qui changerait de réponse entre la vérification et la connexion
 *   (DNS rebinding) n'y gagne rien. Si UNE des adresses du nom est interne, tout
 *   est refusé ;
 * - le certificat reste vérifié pour le nom demandé (SNI) ;
 * - les redirections sont suivies à la main, chacune revérifiée, 5 au plus ;
 * - un délai pour toute la lecture, redirections comprises ; une taille
 *   maximale comptée APRÈS décompression (une bombe gzip s'arrête là) ;
 * - seulement du HTML ou du texte.
 */

const https = require('https');
const dns = require('dns');
const zlib = require('zlib');
const { PassThrough, pipeline } = require('stream');
const { WebSearchError, CODES } = require('./errors');
const { parseHttps } = require('./url');
const { isPublicAddress, isBlockedHostname } = require('./address');

const DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxBytes: 2_000_000,
  maxRedirects: 5,
  ports: [443],
  userAgent: 'Mozilla/5.0 (compatible; AstratraWebSearch/1.0)'
});
const ACCEPTED_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

function blocked(code, message) {
  return new WebSearchError(code, message);
}

/**
 * Un `lookup` pour https.request qui ne rend que des adresses publiques.
 * @param {Function} resolve (hostname, { all: true }, cb) — dns.lookup par défaut.
 */
function safeLookup(resolve = dns.lookup) {
  return function lookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    resolve(hostname, { all: true, family: opts.family || 0 }, (error, addresses) => {
      if (error) return cb(error);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: opts.family || 4 }])
        .filter((entry) => entry && entry.address);
      if (!list.length) return cb(blocked(CODES.BLOCKED_ADDRESS, 'no address'));
      if (list.some((entry) => !isPublicAddress(entry.address))) return cb(blocked(CODES.BLOCKED_ADDRESS, 'address is not public'));
      if (opts.all) return cb(null, list.map(({ address, family }) => ({ address, family: family || (address.includes(':') ? 6 : 4) })));
      const first = list[0];
      return cb(null, first.address, first.family || (first.address.includes(':') ? 6 : 4));
    });
  };
}

/** Vérifie une adresse avant tout appel réseau. */
function checkUrl(value, ports) {
  const url = parseHttps(value);
  if (!url) throw blocked(CODES.BLOCKED_URL, 'only https addresses without credentials can be read');
  const port = url.port ? Number(url.port) : 443;
  if (!ports.includes(port)) throw blocked(CODES.BLOCKED_URL, `port ${port} is not allowed`);
  if (isBlockedHostname(url.hostname)) throw blocked(CODES.BLOCKED_ADDRESS, 'host is not public');
  return url;
}

function decoderFor(encoding) {
  const value = String(encoding || '').toLowerCase().trim();
  if (value === 'gzip' || value === 'x-gzip') return zlib.createGunzip();
  if (value === 'deflate') return zlib.createInflate();
  if (value === 'br') return zlib.createBrotliDecompress();
  return null;
}

function charsetOf(contentType, head) {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1];
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : 'utf-8';
}

function decode(buffer, charset) {
  try {
    return new globalThis.TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch (_error) {
    return new globalThis.TextDecoder('utf-8').decode(buffer);
  }
}

/** Une seule requête, sans suivre de redirection. */
function once(url, { request, lookup, deadline, maxBytes, headers, signal }) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(blocked(CODES.TIMEOUT, 'page read timed out'));
    const req = request({
      protocol: 'https:',
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers,
      lookup,
      servername: url.hostname.replace(/^\[|\]$/g, ''),
      agent: false
    }, (res) => {
      /* Une réponse qu'on ne lit pas ferme la connexion : jamais un corps lu à vide, sans fin ni plafond. */
      const refuse = (fn, value) => {
        req.destroy();
        res.destroy?.();
        finish(fn, value);
      };
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) return refuse(resolvePromise, { redirect: String(res.headers.location), status });
      if (status < 200 || status >= 300) return refuse(reject, new WebSearchError(CODES.BAD_STATUS, `page answered ${status}`, { status }));
      const contentType = String(res.headers['content-type'] || '');
      const type = contentType.split(';')[0].trim().toLowerCase();
      if (type && !ACCEPTED_TYPES.includes(type)) return refuse(reject, blocked(CODES.UNSUPPORTED_TYPE, `content type ${type.slice(0, 60)} is not read`));
      const declared = Number(res.headers['content-length']);
      const encoding = res.headers['content-encoding'];
      if (!encoding && Number.isFinite(declared) && declared > maxBytes * 4) return refuse(reject, blocked(CODES.TOO_LARGE, 'page is too large'));
      /* pipeline : une connexion coupée en plein corps (compressé ou non) est une erreur tout de suite, pas un délai. */
      const sink = decoderFor(encoding) || new PassThrough();
      const chunks = [];
      let size = 0;
      let truncated = false;
      const done = () => {
        const buffer = Buffer.concat(chunks);
        const charset = charsetOf(contentType, buffer.subarray(0, 2048).toString('latin1'));
        finish(resolvePromise, { status, contentType: type || 'text/html', body: decode(buffer, charset), bytes: buffer.length, truncated });
      };
      sink.on('data', (chunk) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          size = maxBytes;
          truncated = true;
          done();
          req.destroy();
          sink.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      sink.on('end', done);
      pipeline(res, sink, (error) => {
        if (!error || truncated) return;
        req.destroy();
        finish(reject, new WebSearchError(CODES.READ_FAILED, `page could not be read (${String(error.code || 'interrupted').slice(0, 60)})`));
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, blocked(CODES.TIMEOUT, 'page read timed out'));
    }, remaining);
    const onAbort = () => {
      req.destroy();
      finish(reject, signal.reason ?? blocked(CODES.TIMEOUT, 'page read aborted'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (error) => {
      if (error instanceof WebSearchError) return finish(reject, error);
      finish(reject, new WebSearchError(CODES.READ_FAILED, `page could not be read (${String(error.code || 'network').slice(0, 40)})`));
    });
    req.end();
  });
}

/**
 * @param {string} address
 * @param {object} [options]
 * @param {number} [options.timeoutMs]    pour toute la lecture. Défaut 10 s.
 * @param {number} [options.maxBytes]     après décompression. Défaut 2 000 000 ; au-delà, la page est coupée (`truncated`).
 * @param {number} [options.maxRedirects] Défaut 5.
 * @param {number[]} [options.ports]      Défaut [443].
 * @param {string} [options.userAgent]
 * @param {string} [options.lang]         l'en-tête Accept-Language.
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.request]    https.request (remplaçable dans les tests).
 * @param {Function} [options.resolve]    dns.lookup (remplaçable dans les tests).
 * @returns {Promise<{ url: string, finalUrl: string, redirects: string[], status: number, contentType: string, body: string, bytes: number, truncated: boolean }>}
 */
async function safeFetch(address, options = {}) {
  const settings = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
  const deadline = Date.now() + settings.timeoutMs;
  const lookup = safeLookup(settings.resolve || dns.lookup);
  const request = settings.request || https.request;
  const headers = {
    'user-agent': settings.userAgent,
    accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    ...(settings.lang ? { 'accept-language': `${settings.lang},*;q=0.5` } : {})
  };
  const redirects = [];
  let url = checkUrl(address, settings.ports);
  for (;;) {
    const answer = await once(url, { request, lookup, deadline, maxBytes: settings.maxBytes, headers, signal: settings.signal });
    if (!answer.redirect) {
      return { url: String(address), finalUrl: url.href, redirects, status: answer.status, contentType: answer.contentType, body: answer.body, bytes: answer.bytes, truncated: answer.truncated };
    }
    if (redirects.length >= settings.maxRedirects) throw blocked(CODES.TOO_MANY_REDIRECTS, 'too many redirects');
    let next;
    try {
      next = new URL(answer.redirect, url);
    } catch (_error) {
      throw blocked(CODES.BLOCKED_URL, 'redirect to an invalid address');
    }
    url = checkUrl(next.href, settings.ports);
    redirects.push(url.href);
  }
}

module.exports = { safeFetch, safeLookup, checkUrl, SAFE_FETCH_DEFAULTS: DEFAULTS };
