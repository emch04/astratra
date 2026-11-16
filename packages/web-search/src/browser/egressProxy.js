/**
 * Le relais de sortie du navigateur : Chromium n'ouvre AUCUNE connexion
 * lui-même, tout passe par ce relais (`--proxy-server`, boucle locale comprise).
 *
 * Pour chaque connexion (`CONNECT hôte:port`, ou requête `http` si
 * `allowHttp`) :
 * - le port doit être permis ;
 * - le nom est refusé sans résolution s'il est interne, puis résolu ICI ; si
 *   UNE de ses adresses n'est pas publique, la connexion est refusée ;
 * - la connexion part vers l'adresse vérifiée elle-même : un DNS qui
 *   changerait de réponse (DNS rebinding) n'y gagne rien.
 *
 * Les redirections, les WebSocket, les requêtes des scripts, des images ou
 * des cadres passent toutes par ici : c'est ce qui les couvre, l'interception
 * de Playwright ne voyant pas les redirections. Le TLS reste de bout en bout
 * (tunnel, pas de déchiffrement).
 *
 * Le relais écoute sur 127.0.0.1 et demande un identifiant tiré au hasard au
 * lancement : un autre processus de la machine ne peut pas s'en servir.
 */

const http = require('http');
const net = require('net');
const dns = require('dns');
const crypto = require('crypto');
const { isPublicAddress, isBlockedHostname } = require('../address');

function lookupAll(resolve, hostname) {
  return new Promise((resolvePromise, reject) => {
    resolve(hostname, { all: true, family: 0 }, (error, addresses) => {
      if (error) return reject(error);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses }]).map((entry) => (typeof entry === 'string' ? entry : entry?.address)).filter(Boolean);
      return resolvePromise(list);
    });
  });
}

/** `hôte:port` d'une ligne CONNECT (IPv6 entre crochets). */
function splitTarget(value) {
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(value) || /^([^:]+):(\d+)$/.exec(value);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: match[1].toLowerCase().replace(/\.$/, ''), port };
}

/**
 * @param {object} [options]
 * @param {Function} [options.resolve]    dns.lookup (tests).
 * @param {Function} [options.connect]    ({ hostname, address, port }) => net.Socket (tests).
 * @param {number[]} [options.ports]      Défaut [443] (et 80 avec allowHttp).
 * @param {boolean} [options.allowHttp]
 * @param {number} [options.port]         Défaut 0 (un port libre) ; fixe en production pour le pare-feu.
 * @param {string} [options.host]         Défaut 127.0.0.1.
 * @param {number} [options.idleMs]       Défaut 30 s.
 * @param {Function} [options.onRefused]  ({ hostname, port, reason }) => void.
 */
async function startEgressProxy(options = {}) {
  const resolve = options.resolve || dns.lookup;
  const allowHttp = options.allowHttp === true;
  const ports = new Set(options.ports || (allowHttp ? [443, 80] : [443]));
  const idleMs = options.idleMs ?? 30_000;
  const username = 'astratra';
  const password = crypto.randomBytes(18).toString('base64url');
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const stats = { tunnels: 0, refused: 0, open: 0 };
  const sockets = new Set();

  const authorized = (req) => {
    const given = String(req.headers['proxy-authorization'] || '');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  /** null si permis, sinon la raison ; `address` : l'adresse vérifiée. */
  async function vet(hostname, port) {
    if (!ports.has(port)) return { reason: 'port' };
    const host = hostname.replace(/^\[|\]$/g, '');
    if (isBlockedHostname(host)) return { reason: 'address' };
    if (net.isIP(host)) return { address: host };
    let addresses;
    try {
      addresses = await lookupAll(resolve, host);
    } catch (_error) {
      return { reason: 'dns' };
    }
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) return { reason: 'address' };
    return { address: addresses[0] };
  }

  const refused = (hostname, port, reason) => {
    stats.refused += 1;
    try {
      options.onRefused?.({ hostname, port, reason });
    } catch (_error) {
      /* un observateur ne casse rien */
    }
  };

  const open = ({ hostname, address, port }) => (options.connect
    ? options.connect({ hostname, address, port })
    : net.connect({ host: address, port }));

  const server = http.createServer(async (req, res) => {
    /* Requête http ordinaire (adresse absolue) : seulement avec allowHttp. */
    if (!authorized(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="astratra"', connection: 'close' });
      return res.end();
    }
    let url;
    try {
      url = new URL(req.url);
    } catch (_error) {
      res.writeHead(400, { connection: 'close' });
      return res.end();
    }
    if (!allowHttp || url.protocol !== 'http:') {
      refused(url.hostname, Number(url.port || 80), 'protocol');
      res.writeHead(403, { connection: 'close' });
      return res.end();
    }
    const port = Number(url.port || 80);
    const verdict = await vet(url.hostname.toLowerCase(), port);
    if (verdict.reason) {
      refused(url.hostname, port, verdict.reason);
      res.writeHead(403, { connection: 'close' });
      return res.end();
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request({
      host: verdict.address,
      port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: url.host },
      createConnection: options.connect ? () => open({ hostname: url.hostname, address: verdict.address, port }) : undefined,
      timeout: idleMs
    }, (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { connection: 'close' });
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connect', async (req, client, head) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    if (!authorized(req)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="astratra"\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = splitTarget(String(req.url || ''));
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const verdict = await vet(target.hostname, target.port);
    if (verdict.reason) {
      refused(target.hostname, target.port, verdict.reason);
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    let upstream;
    try {
      upstream = open({ hostname: target.hostname, address: verdict.address, port: target.port });
    } catch (_error) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.add(upstream);
    stats.tunnels += 1;
    stats.open += 1;
    upstream.setTimeout(idleMs, () => {
      upstream.destroy();
      client.destroy();
    });
    client.setTimeout(idleMs, () => {
      client.destroy();
      upstream.destroy();
    });
    let connected = false;
    upstream.on('connect', () => {
      connected = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      /* pipe() ferme chaque côté quand l'autre a fini : rien de ce qui est déjà reçu n'est perdu. */
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!connected && !client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      else client.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      stats.open -= 1;
      if (!client.destroyed && !client.writableEnded) client.end();
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host || '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const { port } = server.address();
  return {
    port,
    server: `http://127.0.0.1:${port}`,
    username,
    password,
    stats: () => ({ ...stats }),
    close: () => new Promise((resolvePromise) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolvePromise());
    })
  };
}

module.exports = { startEgressProxy };
