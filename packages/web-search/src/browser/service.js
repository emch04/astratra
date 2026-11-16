/**
 * Le service `astratra-web-browser` : le moteur servi en HTTP, sur la boucle
 * locale seulement.
 *
 *   POST /v1/open         { url, screenshot?, waitFor?, allowDomains?, blockDomains?, lang? }
 *   POST /v1/site-search  { url, query, screenshot?, allowDomains?, blockDomains?, lang? }
 *   GET  /health
 *
 * - écoute 127.0.0.1 (ou ::1), jamais une autre adresse ;
 * - jeton `Authorization: Bearer`, lu dans `tokenFile` à chaque requête (un
 *   jeton changé vaut tout de suite, sans redémarrer) ; comparé à temps
 *   constant ; 16 caractères au moins ;
 * - corps JSON de 16 Kio au plus ;
 * - file bornée du moteur : au-delà, `503 busy` ;
 * - au démarrage, contrôle d'isolement (`checkIsolation`) : s'il échoue, le
 *   service refuse de démarrer, sauf `unsafeNoFirewall` (développement).
 *
 * Réponses : 200 avec le résultat (dont `status` : ok, robots_disallowed…),
 * ou { error: { code, message } } avec 400, 401, 404, 405, 413, 415, 503.
 */

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { checkIsolation } = require('./isolation');

const VERSION = require('../../package.json').version;
const MAX_BODY = 16 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

function domainList(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200 || value.some((item) => !isString(item, 253))) {
    throw new ServiceError(400, 'invalid_input', `${name}: up to 200 site names.`);
  }
  return value;
}

/** La demande, validée champ par champ ; les champs inconnus sont refusés. */
function validate(body, kind) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError(400, 'invalid_input', 'a JSON object is expected.');
  const allowed = kind === 'open'
    ? ['url', 'screenshot', 'waitFor', 'allowDomains', 'blockDomains', 'lang']
    : ['url', 'query', 'screenshot', 'allowDomains', 'blockDomains', 'lang'];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ServiceError(400, 'invalid_input', `unknown field ${unknown[0].slice(0, 40)}.`);
  if (!isString(body.url, 2048)) throw new ServiceError(400, 'invalid_input', 'url: an https address.');
  if (body.screenshot !== undefined && typeof body.screenshot !== 'boolean') throw new ServiceError(400, 'invalid_input', 'screenshot: boolean.');
  if (body.waitFor !== undefined && !isString(body.waitFor, 200)) throw new ServiceError(400, 'invalid_input', 'waitFor: a CSS selector of 200 characters at most.');
  if (body.lang !== undefined && !(typeof body.lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.lang))) throw new ServiceError(400, 'invalid_input', 'lang: fr or fr-FR.');
  if (kind === 'site-search' && !isString(body.query, 200)) throw new ServiceError(400, 'invalid_input', 'query: 1 to 200 characters.');
  return {
    url: body.url,
    ...(body.screenshot !== undefined ? { screenshot: body.screenshot } : {}),
    ...(body.waitFor !== undefined ? { waitFor: body.waitFor } : {}),
    ...(body.query !== undefined ? { query: body.query } : {}),
    ...(body.lang !== undefined ? { lang: body.lang } : {}),
    ...(domainList(body.allowDomains, 'allowDomains') ? { allowDomains: body.allowDomains } : {}),
    ...(domainList(body.blockDomains, 'blockDomains') ? { blockDomains: body.blockDomains } : {})
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return reject(new ServiceError(415, 'invalid_input', 'content-type: application/json.'));
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) return reject(new ServiceError(413, 'payload_too_large', 'body over 16 KiB.'));
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ServiceError(413, 'payload_too_large', 'body over 16 KiB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_error) {
        reject(new ServiceError(400, 'invalid_input', 'the body is not valid JSON.'));
      }
    });
    req.on('error', () => reject(new ServiceError(400, 'invalid_input', 'the body could not be read.')));
  });
}

/**
 * @param {object} options
 * @param {object} options.engine            createBrowserEngine(…) : { open, siteSearch, health, start, close }.
 * @param {string} options.tokenFile         le fichier du jeton (relu à chaque requête).
 * @param {string} [options.host]            127.0.0.1 (défaut) ou ::1.
 * @param {number} [options.port]            Défaut 5008.
 * @param {boolean} [options.unsafeNoFirewall]  démarrer même si l'intérieur est joignable (développement seulement).
 * @param {Function} [options.checkIsolation]   (tests).
 * @param {Function} [options.log]           (event) => void : un événement par requête, sans contenu de page.
 */
function createBrowserService(options = {}) {
  const engine = options.engine;
  if (!engine || typeof engine.open !== 'function' || typeof engine.siteSearch !== 'function') throw new TypeError('createBrowserService needs an engine from createBrowserEngine().');
  if (typeof options.tokenFile !== 'string' || !options.tokenFile) throw new TypeError('createBrowserService needs a tokenFile.');
  const host = options.host || '127.0.0.1';
  if (!LOOPBACK.has(host)) throw new TypeError('The browser service listens on 127.0.0.1 or ::1 only.');
  const port = options.port ?? 5008;
  const isolationCheck = options.checkIsolation || checkIsolation;
  const log = typeof options.log === 'function' ? options.log : () => {};
  let isolation = null;
  let server = null;

  async function expectedToken() {
    try {
      const token = (await fs.promises.readFile(options.tokenFile, 'utf8')).trim();
      return token.length >= 16 ? token : null;
    } catch (_error) {
      return null;
    }
  }

  async function authorize(req) {
    const token = await expectedToken();
    if (!token) throw new ServiceError(503, 'token_unavailable', 'the service token file is missing or too short.');
    const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    const given = Buffer.from(match ? match[1].trim() : '');
    const wanted = Buffer.from(token);
    /* Comparaison à temps constant, sur des empreintes de même longueur. */
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(wanted).digest();
    if (!crypto.timingSafeEqual(a, b) || given.length !== wanted.length) throw new ServiceError(401, 'unauthorized', 'a valid bearer token is required.');
  }

  function send(res, status, body) {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    res.end(text);
  }

  async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url || '/', 'http://local');
    const route = `${req.method} ${url.pathname}`;
    let outcome = 'error';
    try {
      await authorize(req);
      if (route === 'GET /health') {
        const health = typeof engine.health === 'function' ? await engine.health() : { ok: true };
        outcome = health.ok && isolation?.ok !== false ? 'ok' : 'degraded';
        return send(res, 200, { ...health, ok: Boolean(health.ok) && (isolation ? isolation.ok || options.unsafeNoFirewall === true : true), version: VERSION, isolation, unsafeNoFirewall: options.unsafeNoFirewall === true });
      }
      const kind = route === 'POST /v1/open' ? 'open' : route === 'POST /v1/site-search' ? 'site-search' : null;
      if (!kind) {
        if (['/v1/open', '/v1/site-search', '/health'].includes(url.pathname)) throw new ServiceError(405, 'method_not_allowed', 'method not allowed.');
        throw new ServiceError(404, 'not_found', 'not found.');
      }
      const request = validate(await readBody(req), kind);
      const controller = new globalThis.AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const result = kind === 'open'
        ? await engine.open(request, { signal: controller.signal })
        : await engine.siteSearch(request, { signal: controller.signal });
      outcome = result.status;
      if (result.status === 'busy') throw new ServiceError(503, 'busy', 'too many pages are open; try again later.');
      if (result.status === 'invalid_input') throw new ServiceError(400, 'invalid_input', `${result.reason || 'request'} is invalid.`);
      if (result.status === 'browser_unavailable') throw new ServiceError(503, 'unavailable', 'the browser could not start.');
      return send(res, 200, result);
    } catch (error) {
      const known = error instanceof ServiceError;
      if (known) outcome = error.code;
      return send(res, known ? error.status : 500, { error: { code: known ? error.code : 'server_error', message: known ? error.message : 'internal error.' } });
    } finally {
      try {
        log({ route, outcome, ms: Date.now() - started });
      } catch (_error) {
        /* le journal ne casse rien */
      }
    }
  }

  /**
   * Démarre : le moteur (cloisonnement vérifié), le serveur, puis le contrôle
   * d'isolement. Lève `isolation_failed` si l'intérieur est joignable.
   */
  async function start() {
    if (typeof engine.start === 'function') await engine.start();
    server = http.createServer((req, res) => {
      handle(req, res).catch(() => send(res, 500, { error: { code: 'server_error', message: 'internal error.' } }));
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 60_000;
    server.keepAliveTimeout = 5_000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    isolation = await isolationCheck({ servicePort: server.address().port });
    if (!isolation.ok && options.unsafeNoFirewall !== true) {
      await close();
      const error = new Error('isolation_failed: the browser can reach the internal network; install the firewall rules (astratra-web-browser setup).');
      error.code = 'isolation_failed';
      error.isolation = isolation;
      throw error;
    }
    return { host, port: server.address().port, isolation };
  }

  async function close() {
    const current = server;
    server = null;
    if (current) {
      current.closeAllConnections?.();
      await new Promise((resolve) => current.close(() => resolve()));
    }
    if (typeof engine.close === 'function') await engine.close();
  }

  return { start, close, address: () => server?.address() || null, isolation: () => isolation };
}

module.exports = { createBrowserService, validateBrowserRequest: validate };
