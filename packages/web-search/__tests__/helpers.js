/* Des fournisseurs et un réseau simulés : aucun test n'appelle Internet. */
const net = require('net');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

/** Un fournisseur qui rend des résultats écrits d'avance (ou une fonction de la demande). */
function fakeProvider(id, answer, extra = {}) {
  const calls = [];
  return {
    id,
    costPerCallUsd: 0.001,
    calls,
    ...extra,
    async search(request, context) {
      calls.push({ request, context });
      const value = typeof answer === 'function' ? await answer(request, calls.length) : answer;
      if (value instanceof Error) throw value;
      return { hits: value };
    }
  };
}

const hit = (url, title, snippet, publishedAt = null) => ({ url, title, snippet, publishedAt });

/**
 * Un https.request simulé. `hosts` : { 'example.com': { addresses: ['93.184.216.34'], pages: { '/a': { status, headers, body, gzip } } } }.
 * La connexion passe par `options.lookup`, comme le vrai : c'est lui qui refuse les adresses internes.
 */
function fakeNetwork(hosts) {
  const log = [];
  const resolve = (hostname, _options, cb) => {
    const host = hosts[hostname];
    if (!host) return cb(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const addresses = typeof host.addresses === 'function' ? host.addresses() : host.addresses;
    return cb(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
  const request = (options, callback) => {
    const req = new EventEmitter();
    let destroyed = false;
    req.destroy = () => {
      if (!destroyed) log.push(`closed ${options.hostname}${options.path}`);
      destroyed = true;
    };
    req.end = () => {
      const respond = () => {
        if (destroyed) return;
        log.push(`${options.hostname}${options.path}`);
        const page = hosts[options.hostname]?.pages?.[options.path];
        if (!page) return req.emit('error', Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        if (page.hang) return;
        const res = new PassThrough();
        res.statusCode = page.status || 200;
        res.headers = { 'content-type': 'text/html; charset=utf-8', ...(page.headers || {}) };
        let body = Buffer.isBuffer(page.body) ? page.body : Buffer.from(page.body || '');
        if (page.gzip) {
          body = zlib.gzipSync(body);
          res.headers['content-encoding'] = 'gzip';
        }
        callback(res);
        if (page.cut) {
          /* La connexion tombe au milieu du corps. */
          res.write(body.subarray(0, Math.floor(body.length / 2)));
          return setImmediate(() => res.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
        }
        if (page.endless) {
          /* Un corps sans fin : seule une connexion fermée l'arrête. */
          const pump = () => {
            if (destroyed || res.destroyed) return;
            res.write(Buffer.alloc(64 * 1024, 97));
            setImmediate(pump);
          };
          return pump();
        }
        res.end(body);
      };
      if (net.isIP(options.hostname)) return setImmediate(respond);
      options.lookup(options.hostname, { all: true }, (error) => {
        if (error) return req.emit('error', error);
        setImmediate(respond);
      });
    };
    return req;
  };
  return { request, resolve, log };
}

module.exports = { fakeProvider, hit, fakeNetwork };
