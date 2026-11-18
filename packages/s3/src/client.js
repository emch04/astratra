const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { signRequest, presignQuery, encodePath, canonicalQuery, sha256Hex, UNSIGNED_PAYLOAD } = require('./sigv4');
const { parseXml, childrenOf, textOf, escapeXml, XmlError } = require('./xml');

/*
 * Un client S3 sans SDK : objets (déposer, lire, lire une plage, en-têtes, supprimer, lister) et liens signés, pour
 * AWS S3, Cloudflare R2, MinIO, SeaweedFS et tout service compatible. Il remplace @aws-sdk/client-s3 et
 * @aws-sdk/s3-request-presigner pour ces usages, avec node:crypto et node:http(s).
 *
 * Ce qu'il garde du SDK : les erreurs portent `name` (NoSuchKey, AccessDenied, NotFound…) et
 * `$metadata.httpStatusCode`, comme celles du SDK, pour que le code qui les trie ne change pas.
 *
 * Différences voulues :
 *   - une clé vide, qui commence par « / », qui contient un segment « . » ou « .. » ou un caractère de contrôle est
 *     refusée (S3 les accepte, mais elles se lisent mal ou se normalisent en route) ; un nom de compartiment hors
 *     des règles d'AWS aussi ;
 *   - http:// n'est accepté que vers la machine elle-même (127.0.0.1, ::1, localhost) ;
 *   - un délai de 30 s par défaut, une réponse d'erreur ou de liste lue jusqu'à 1 Mio, un objet lu en mémoire jusqu'à
 *     100 Mio (`maxBytes`), une redirection jamais suivie, aucun nouvel essai caché (au projet de décider) ;
 *   - les listes demandent les clés encodées (encoding-type=url) : une clé avec un caractère interdit en XML ne casse
 *     pas la réponse ;
 *   - un lien signé dure au plus 7 jours (la limite d'AWS) ; aucune somme de contrôle CRC n'est ajoutée (le hachage
 *     SHA-256 du corps est signé, et R2 refusait les sommes ajoutées par les SDK récents).
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_XML = 1024 * 1024;
const MAX_PUT = 5 * 1024 ** 3;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const RANGE = /^bytes=(\d{1,19})?-(\d{1,19})?$/;
const META_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const HEADER_VALUE = /^[\t\x20-\x7e]{0,2048}$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
// Les caractères de contrôle (C0, DEL et C1) : jamais dans une clé ni un préfixe.
const CONTROL = /\p{Cc}/u;

class S3Error extends Error {
  constructor(name, message, { statusCode, requestId, resource, key, fault } = {}) {
    super(message);
    this.name = name;
    this.Code = name;
    this.$fault = fault || (statusCode && statusCode >= 500 ? 'server' : 'client');
    this.$metadata = { httpStatusCode: statusCode, requestId };
    if (resource) this.Resource = resource;
    if (key) this.Key = key;
  }
}

const invalid = (message) => new S3Error('InvalidRequest', message, { fault: 'client' });

function checkKey(key) {
  if (typeof key !== 'string' || !key) throw invalid('key must be a non-empty string');
  if (Buffer.byteLength(key) > 1024) throw invalid('key must be at most 1024 bytes');
  if (CONTROL.test(key)) throw invalid('key must not contain control characters');
  if (key.startsWith('/')) throw invalid('key must not start with "/"');
  if (key.split('/').some((s) => s === '.' || s === '..')) throw invalid('key must not contain "." or ".." segments');
  if (!key.isWellFormed()) throw invalid('key must be valid Unicode');
  return key;
}

function checkBucket(bucket) {
  if (typeof bucket !== 'string' || !BUCKET.test(bucket) || bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) throw invalid('bucket must be a valid bucket name (3 to 63 lowercase letters, digits, dots and hyphens)');
  return bucket;
}

function checkHeaderValue(name, value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  if (!HEADER_VALUE.test(text)) throw invalid(`${name} must be printable ASCII without line breaks`);
  return text;
}

function parseEndpoint(endpoint, region) {
  if (endpoint === undefined) {
    if (!region || region === 'auto') throw invalid('endpoint is required unless region names an AWS region');
    return new URL(`https://s3.${region}.amazonaws.com`);
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid('endpoint must be a URL');
  }
  if (url.username || url.password) throw invalid('endpoint must not contain credentials');
  if (url.pathname !== '/' || url.search || url.hash) throw invalid('endpoint must be an origin, without path or query');
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) throw invalid('endpoint must use https:// (http:// only to this machine)');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('endpoint must use https://');
  return url;
}

const isIpOrLocal = (hostname) => LOOPBACK.has(hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith('[');

/**
 * @param {object} options
 * @param {string} [options.endpoint]  « https://<compte>.r2.cloudflarestorage.com », « http://127.0.0.1:9000 »… ;
 *   sans lui, l'adresse S3 de `region`.
 * @param {string} [options.region='auto']  « auto » pour R2 ; la région AWS sinon.
 * @param {string} options.accessKeyId
 * @param {string} options.secretAccessKey
 * @param {string} [options.sessionToken]
 * @param {string} [options.bucket]  Le compartiment par défaut.
 * @param {boolean} [options.forcePathStyle=false]  « https://hôte/compartiment/clé » au lieu de
 *   « https://compartiment.hôte/clé » (toujours pour une adresse IP, localhost ou un nom avec des points en https).
 * @param {number} [options.timeoutMs=30000]
 * @param {object} [options.agent]  Un agent http(s) (mandataire, autorité de certification).
 * @param {Function} [options.now]  Horloge, pour les essais.
 */
function createS3Client(options = {}) {
  const region = options.region ?? 'auto';
  if (typeof region !== 'string' || !/^[a-z0-9-]{1,32}$/.test(region)) throw invalid('region must be a region name or "auto"');
  const endpoint = parseEndpoint(options.endpoint, region);
  const { accessKeyId, secretAccessKey, sessionToken } = options;
  if (typeof accessKeyId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(accessKeyId) || accessKeyId.includes('/')) throw invalid('accessKeyId is required');
  if (typeof secretAccessKey !== 'string' || !secretAccessKey || secretAccessKey.length > 256) throw invalid('secretAccessKey is required');
  if (sessionToken !== undefined && (typeof sessionToken !== 'string' || !HEADER_VALUE.test(sessionToken))) throw invalid('sessionToken must be a string');
  const credentials = { accessKeyId, secretAccessKey, sessionToken };
  const defaultBucket = options.bucket === undefined ? undefined : checkBucket(options.bucket);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw invalid('timeoutMs must be a number of milliseconds');
  const now = options.now || Date.now;
  const transport = endpoint.protocol === 'https:' ? https : http;

  /** L'hôte et le chemin (encodé) d'un objet ou d'un compartiment. */
  function locate(bucket, key) {
    const b = checkBucket(bucket ?? defaultBucket ?? (() => { throw invalid('bucket is required'); })());
    const keyPath = key === undefined ? '' : encodePath(checkKey(key));
    const pathStyle = options.forcePathStyle === true || isIpOrLocal(endpoint.hostname) || (b.includes('.') && endpoint.protocol === 'https:');
    if (pathStyle) return { host: endpoint.host, hostname: endpoint.hostname, path: `/${b}/${keyPath}`, bucket: b };
    return { host: `${b}.${endpoint.host}`, hostname: `${b}.${endpoint.hostname}`, path: `/${keyPath}`, bucket: b };
  }

  /** La requête signée, prête à partir : hôte, chemin, requête, en-têtes (signature comprise) et corps. */
  function prepare({ method, bucket, key, query = {}, headers = {}, body }) {
    const where = locate(bucket, key);
    const payload = body === undefined ? null : body;
    const payloadHash = payload ? sha256Hex(payload) : sha256Hex('');
    const base = { host: where.host, ...headers };
    if (payload) base['content-length'] = String(payload.length);
    else if (method === 'PUT' || method === 'POST') base['content-length'] = '0';
    const signed = signRequest({ method, path: where.path, query, headers: base, payloadHash, region, credentials, date: new Date(now()) });
    return { method, where, query, search: canonicalQuery(query), headers: signed, payload };
  }

  /** Envoie une requête signée ; rend { statusCode, headers, body } (body : Buffer, ou le flux si stream). */
  function send({ stream = false, maxBytes = MAX_XML, ...spec }) {
    const { method, key } = spec;
    const { where, search, headers: signed, payload } = prepare(spec);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const req = transport.request(
        {
          hostname: where.hostname.replace(/^\[|\]$/g, ''),
          port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
          path: `${where.path}${search ? `?${search}` : ''}`,
          method,
          headers: signed,
          agent: options.agent,
        },
        (res) => {
          const ok = res.statusCode >= 200 && res.statusCode <= 299;
          if (ok && stream) {
            clearTimeout(timer);
            settled = true;
            res.setTimeout(timeoutMs, () => res.destroy(new S3Error('TimeoutError', `object stream idle for ${timeoutMs} ms`, { fault: 'client' })));
            resolve({ statusCode: res.statusCode, headers: res.headers, body: res });
            return;
          }
          const limit = ok ? maxBytes : MAX_XML;
          const announced = Number(res.headers['content-length']);
          if (ok && Number.isFinite(announced) && announced > limit) {
            res.destroy();
            finish(reject, new S3Error('ObjectTooLarge', `object is ${announced} bytes, more than maxBytes (${limit})`, { statusCode: res.statusCode, key }));
            return;
          }
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
              res.destroy();
              finish(reject, ok ? new S3Error('ObjectTooLarge', `object is more than maxBytes (${limit})`, { statusCode: res.statusCode, key }) : toError(res, Buffer.concat(chunks), method, key));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const data = Buffer.concat(chunks);
            if (ok) finish(resolve, { statusCode: res.statusCode, headers: res.headers, body: data });
            else finish(reject, toError(res, data, method, key));
          });
          res.on('error', (error) => finish(reject, error));
        }
      );
      const timer = setTimeout(() => {
        const error = new S3Error('TimeoutError', `S3 did not answer within ${timeoutMs} ms`, { fault: 'client' });
        finish(reject, error);
        req.destroy(error);
      }, timeoutMs);
      timer.unref?.();
      req.on('error', (error) => finish(reject, error));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** L'erreur S3 lue dans la réponse (XML), ou nommée d'après le statut quand il n'y a pas de corps (HEAD). */
  function toError(res, data, method, key) {
    const statusCode = res.statusCode;
    const requestId = res.headers['x-amz-request-id'];
    let code;
    let message;
    let resource;
    if (data.length && method !== 'HEAD') {
      try {
        const root = parseXml(data, { maxBytes: MAX_XML });
        if (root.name === 'Error') {
          code = textOf(root, 'Code');
          message = textOf(root, 'Message');
          resource = textOf(root, 'Resource');
        }
      } catch (error) {
        if (!(error instanceof XmlError)) throw error;
      }
    }
    if (!code || !/^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(code)) code = { 301: 'MovedPermanently', 307: 'TemporaryRedirect', 400: 'BadRequest', 403: 'Forbidden', 404: 'NotFound', 409: 'Conflict', 412: 'PreconditionFailed', 416: 'InvalidRange', 429: 'SlowDown', 500: 'InternalError', 503: 'ServiceUnavailable' }[statusCode] || `Http${statusCode}`;
    return new S3Error(code, (message || code).slice(0, 500), { statusCode, requestId, resource, key });
  }

  const etagOf = (headers) => (headers.etag ? String(headers.etag).replace(/"/g, '') : undefined);
  function describe(headers) {
    const metadata = {};
    for (const [name, value] of Object.entries(headers)) if (name.startsWith('x-amz-meta-')) metadata[name.slice(11)] = String(value);
    return {
      contentType: headers['content-type'],
      contentLength: headers['content-length'] === undefined ? undefined : Number(headers['content-length']),
      contentRange: headers['content-range'],
      etag: etagOf(headers),
      lastModified: headers['last-modified'] ? new Date(headers['last-modified']) : undefined,
      cacheControl: headers['cache-control'],
      contentDisposition: headers['content-disposition'],
      contentEncoding: headers['content-encoding'],
      versionId: headers['x-amz-version-id'],
      metadata,
    };
  }

  function objectHeaders({ contentType, cacheControl, contentDisposition, contentEncoding, metadata, ifNoneMatch, ifMatch } = {}) {
    const headers = {};
    const set = (name, value, label) => {
      const text = checkHeaderValue(label, value);
      if (text !== undefined) headers[name] = text;
    };
    set('content-type', contentType, 'contentType');
    set('cache-control', cacheControl, 'cacheControl');
    set('content-disposition', contentDisposition, 'contentDisposition');
    set('content-encoding', contentEncoding, 'contentEncoding');
    if (ifNoneMatch !== undefined) {
      if (ifNoneMatch !== '*') throw invalid('ifNoneMatch must be "*" (create only if absent)');
      headers['if-none-match'] = '*';
    }
    set('if-match', ifMatch === undefined ? undefined : `"${String(ifMatch).replace(/"/g, '')}"`, 'ifMatch');
    if (metadata !== undefined) {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw invalid('metadata must be an object');
      let total = 0;
      for (const [name, value] of Object.entries(metadata)) {
        const lower = name.toLowerCase();
        if (!META_NAME.test(lower)) throw invalid(`metadata name ${JSON.stringify(name).slice(0, 40)} must be letters, digits and hyphens`);
        if (typeof value !== 'string' && typeof value !== 'number') throw invalid(`metadata ${lower} must be a string`);
        const text = checkHeaderValue(`metadata ${lower}`, value);
        total += lower.length + text.length;
        headers[`x-amz-meta-${lower}`] = text;
      }
      if (total > 2048) throw invalid('metadata must be at most 2 KB in all (the S3 limit)');
    }
    return headers;
  }

  function toBody(body) {
    if (typeof body === 'string') return Buffer.from(body, 'utf8');
    if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    throw invalid('body must be a Buffer, a Uint8Array or a string');
  }

  function checkRange(range) {
    if (range === undefined) return undefined;
    const match = typeof range === 'string' ? RANGE.exec(range) : null;
    if (!match || (match[1] === undefined && match[2] === undefined) || (match[1] !== undefined && match[2] !== undefined && BigInt(match[1]) > BigInt(match[2]))) throw invalid('range must be "bytes=start-end", "bytes=start-" or "bytes=-suffix"');
    return range;
  }

  /** Ce que chaque opération envoie (sans l'envoyer) : vérifie les entrées et décrit la requête. */
  const builders = {
    putObject({ bucket, key, body, ...rest } = {}) {
      const data = toBody(body);
      if (data.length > MAX_PUT) throw invalid('body must be at most 5 GiB (one PUT)');
      return { method: 'PUT', bucket, key: checkKey(key), headers: objectHeaders(rest), body: data };
    },
    getObject({ bucket, key, range, maxBytes = DEFAULT_MAX_BYTES } = {}) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw invalid('maxBytes must be a number of bytes');
      return { method: 'GET', bucket, key: checkKey(key), headers: range ? { range: checkRange(range) } : {}, maxBytes };
    },
    getObjectStream({ bucket, key, range } = {}) {
      return { method: 'GET', bucket, key: checkKey(key), headers: range ? { range: checkRange(range) } : {}, stream: true };
    },
    headObject({ bucket, key } = {}) {
      return { method: 'HEAD', bucket, key: checkKey(key) };
    },
    deleteObject({ bucket, key } = {}) {
      return { method: 'DELETE', bucket, key: checkKey(key) };
    },
    deleteObjects({ bucket, keys } = {}) {
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > 1000) throw invalid('keys must be an array of 1 to 1000 keys');
      const body = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>false</Quiet>${keys.map((k) => `<Object><Key>${escapeXml(checkKey(k))}</Key></Object>`).join('')}</Delete>`);
      return { method: 'POST', bucket, query: { delete: '' }, headers: { 'content-type': 'application/xml', 'content-md5': crypto.createHash('md5').update(body).digest('base64') }, body };
    },
    listObjects({ bucket, prefix, delimiter, continuationToken, startAfter, maxKeys } = {}) {
      if (maxKeys !== undefined && (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000)) throw invalid('maxKeys must be between 1 and 1000');
      for (const [name, value] of [['prefix', prefix], ['delimiter', delimiter], ['continuationToken', continuationToken], ['startAfter', startAfter]]) {
        if (value !== undefined && (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value) > 1024 || CONTROL.test(value))) throw invalid(`${name} must be a string of at most 1024 bytes`);
      }
      return { method: 'GET', bucket, query: { 'list-type': '2', 'encoding-type': 'url', prefix, delimiter, 'continuation-token': continuationToken, 'start-after': startAfter, 'max-keys': maxKeys } };
    },
  };

  // Une entrée qui n'est pas un objet (null, un texte, un tableau) est refusée avant d'être lue.
  const specs = Object.fromEntries(Object.entries(builders).map(([name, build]) => [name, (input = {}) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(`${name} expects an object`);
    return build(input);
  }]));

  function parseList(res) {
    const root = parseXml(res.body);
    if (root.name !== 'ListBucketResult') throw new S3Error('InvalidResponse', 'S3 answered something other than a list', { statusCode: res.statusCode });
    const encoded = textOf(root, 'EncodingType') === 'url';
    const decode = (value) => {
      if (value === undefined || !encoded) return value;
      try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
      } catch {
        throw new S3Error('InvalidResponse', 'S3 returned a badly encoded key', { statusCode: res.statusCode });
      }
    };
    return {
      objects: childrenOf(root, 'Contents').map((c) => ({ key: decode(textOf(c, 'Key')), size: Number(textOf(c, 'Size')), etag: textOf(c, 'ETag')?.replace(/"/g, ''), lastModified: textOf(c, 'LastModified') ? new Date(textOf(c, 'LastModified')) : undefined, storageClass: textOf(c, 'StorageClass') })),
      prefixes: childrenOf(root, 'CommonPrefixes').map((p) => decode(textOf(p, 'Prefix'))),
      isTruncated: textOf(root, 'IsTruncated') === 'true',
      nextContinuationToken: textOf(root, 'NextContinuationToken'),
      keyCount: textOf(root, 'KeyCount') === undefined ? undefined : Number(textOf(root, 'KeyCount')),
    };
  }

  return {
    /** Dépose un objet. Rend { etag, versionId }. `ifNoneMatch: '*'` : seulement s'il n'existe pas encore. */
    async putObject(input) {
      const res = await send(specs.putObject(input));
      return { etag: etagOf(res.headers), versionId: res.headers['x-amz-version-id'] };
    },

    /** Lit un objet en mémoire (jusqu'à `maxBytes`, 100 Mio par défaut). `range` : « bytes=0-99 ». */
    async getObject(input) {
      const res = await send(specs.getObject(input));
      return { body: res.body, ...describe(res.headers) };
    },

    /** Lit un objet en flux (`stream`, un Readable) : pour un gros fichier, sans tout garder en mémoire. */
    async getObjectStream(input) {
      const res = await send(specs.getObjectStream(input));
      return { stream: res.body, ...describe(res.headers) };
    },

    /** Les en-têtes d'un objet, sans son contenu ; un objet absent lève une S3Error « NotFound » (404). */
    async headObject(input) {
      const res = await send(specs.headObject(input));
      return describe(res.headers);
    },

    /** Supprime un objet (sans erreur s'il n'existait pas, comme S3). */
    async deleteObject(input) {
      const res = await send(specs.deleteObject(input));
      return { versionId: res.headers['x-amz-version-id'] };
    },

    /** Supprime jusqu'à 1 000 objets d'un coup. Rend { deleted: [clé…], errors: [{ key, code, message }…] }. */
    async deleteObjects(input) {
      const res = await send(specs.deleteObjects(input));
      const root = parseXml(res.body);
      return {
        deleted: childrenOf(root, 'Deleted').map((d) => textOf(d, 'Key')),
        errors: childrenOf(root, 'Error').map((e) => ({ key: textOf(e, 'Key'), code: textOf(e, 'Code'), message: textOf(e, 'Message') })),
      };
    },

    /**
     * Une page de la liste (ListObjectsV2) : { objects: [{ key, size, etag, lastModified }], prefixes, isTruncated,
     * nextContinuationToken }. `maxKeys` : 1 à 1 000.
     */
    async listObjects(input) {
      return parseList(await send(specs.listObjects(input)));
    },

    /**
     * La requête qu'enverrait une opération, signée, sans l'envoyer : { method, protocol, hostname, port, path,
     * query, headers }. Pour le débogage et les essais.
     */
    describeRequest(operation, input) {
      if (!Object.hasOwn(specs, operation)) throw invalid(`unknown operation ${String(operation).slice(0, 40)}`);
      const { method, where, query, headers, payload } = prepare(specs[operation](input));
      return { method, protocol: endpoint.protocol, hostname: where.hostname, port: endpoint.port ? Number(endpoint.port) : null, path: where.path, query: Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])), headers, bodyLength: payload ? payload.length : 0 };
    },

    /** Tous les objets d'un préfixe, page après page (au plus `limit`, 100 000 par défaut). */
    async *iterateObjects({ bucket, prefix, limit = 100_000 } = {}) {
      let token;
      let count = 0;
      do {
        const page = await this.listObjects({ bucket, prefix, continuationToken: token });
        for (const object of page.objects) {
          if (count++ >= limit) return;
          yield object;
        }
        token = page.isTruncated ? page.nextContinuationToken : undefined;
        if (page.isTruncated && !token) throw new S3Error('InvalidResponse', 'S3 said the list goes on but gave no continuation token');
      } while (token);
    },

    /**
     * Un lien signé (comme getSignedUrl du SDK) : GET pour lire, PUT pour qu'un navigateur dépose directement.
     * `expiresIn` en secondes (900 par défaut, 7 jours au plus). Pour un PUT, `contentType` et `contentLength`
     * signés : le navigateur doit envoyer exactement ceux-là.
     */
    presignUrl({ bucket, key, method = 'GET', expiresIn = 900, contentType, contentLength, responseContentType, responseContentDisposition, responseCacheControl } = {}) {
      if (!['GET', 'PUT', 'HEAD', 'DELETE'].includes(method)) throw invalid('method must be GET, PUT, HEAD or DELETE');
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604_800) throw invalid('expiresIn must be between 1 second and 7 days');
      const where = locate(bucket, key);
      const headers = { host: where.host };
      if (contentType !== undefined) headers['content-type'] = checkHeaderValue('contentType', contentType);
      if (contentLength !== undefined) {
        if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_PUT) throw invalid('contentLength must be a number of bytes');
        headers['content-length'] = String(contentLength);
      }
      const query = {};
      if (responseContentType !== undefined) query['response-content-type'] = checkHeaderValue('responseContentType', responseContentType);
      if (responseContentDisposition !== undefined) query['response-content-disposition'] = checkHeaderValue('responseContentDisposition', responseContentDisposition);
      if (responseCacheControl !== undefined) query['response-cache-control'] = checkHeaderValue('responseCacheControl', responseCacheControl);
      const search = presignQuery({ method, path: where.path, query, headers, region, credentials, date: new Date(now()), expiresIn });
      return `${endpoint.protocol}//${where.host}${where.path}?${search}`;
    },
  };
}

module.exports = { createS3Client, S3Error, UNSIGNED_PAYLOAD };
