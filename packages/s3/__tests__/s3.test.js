/* global fetch, URLSearchParams */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { standardVectors, assertVectors, assertFuzz, assertProperty, gen, assertSafeRegex, extractRegexLiterals } = require('@astratra/testkit/security');
const { createS3Client, S3Error, signRequest, presignQuery, encodePath, sha256Hex, parseXml, escapeXml, textOf, XmlError } = require('../src');

// Le client S3 sans SDK : exemples de signature d'AWS, signatures, requêtes, liens et lectures de réponses comparés au
// SDK AWS v3 enregistré, un vrai service S3 local (SeaweedFS dans Docker) quand S3_TEST_ENDPOINT est donné, puis
// essais d'attaque sur un faux service local.

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/aws-sdk-reference.json'), 'utf8'));
const CREDS = { accessKeyId: 'AKIAESSAI0000000TEST', secretAccessKey: 'secret-essai-local-que-rien-ne-doit-montrer' };

describe('normes', () => {
  test('les exemples S3 de la documentation d’AWS (en-tête et lien signé)', async () => {
    await assertVectors(standardVectors.sigV4S3Aws, (i) => {
      const filePath = `/${encodePath(i.key)}`;
      const date = new Date(i.date);
      if (i.kind === 'presign') return presignQuery({ method: i.method, path: filePath, query: i.query, headers: { host: i.host }, region: i.region, credentials: i.credentials, date, expiresIn: i.expiresIn, contentSha256Param: false }).split('X-Amz-Signature=')[1];
      const signed = signRequest({ method: i.method, path: filePath, query: i.query, headers: { host: i.host, ...i.headers }, payloadHash: sha256Hex(i.payload), region: i.region, credentials: i.credentials, date });
      return signed.authorization.split('Signature=')[1];
    }, { source: 'documentation AWS' });
  });
});

describe(`comparé à ${reference.source}`, () => {
  test(`mêmes en-têtes Authorization que @smithy/signature-v4 sur ${reference.signerCases.length} requêtes`, async () => {
    await assertVectors(reference.signerCases.map((c, i) => ({ id: `signature ${i} ${c.method} ${c.path.slice(0, 30)}`, input: c, expected: c.authorization })), (c) => signRequest({ method: c.method, path: c.path, query: c.query, headers: c.headers, payloadHash: c.payloadHash, region: c.region, credentials: c.credentials, date: new Date(c.date) }).authorization);
  });

  test(`mêmes liens signés que @smithy/signature-v4 sur ${reference.signerCases.length} requêtes (paramètres et signature)`, async () => {
    await assertVectors(reference.signerCases.map((c, i) => ({ id: `lien ${i}`, input: c, expected: c.presign.query })), (c) => {
      const search = presignQuery({ method: c.method, path: c.path, query: { ...c.query, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }, headers: c.presign.headers, region: c.region, credentials: c.credentials, date: new Date(c.date), expiresIn: c.presign.expiresIn, contentSha256Param: false });
      return Object.fromEntries(new URLSearchParams(search));
    });
  });

  test(`mêmes requêtes que S3Client sur ${reference.clientCases.length} commandes (hôte, chemin, requête, en-têtes), sauf les écarts voulus`, async () => {
    // Écarts voulus : le SDK ajoute « x-id=<Commande> » (sans effet sur S3) ; la liste demande ici encoding-type=url.
    await assertVectors(reference.clientCases.map((c, i) => ({ id: `${c.setup} ${c.operation} ${String(c.input.key ?? '').slice(0, 24)} (${i})`, input: c, expected: (() => {
      const query = { ...c.request.query };
      delete query['x-id'];
      const headers = { ...c.request.headers };
      if (c.operation === 'deleteObjects') delete headers['content-length'];
      return { ...c.request, query, headers };
    })() })), (c) => {
      const client = createS3Client({ ...c.ours, ...CREDS });
      const r = client.describeRequest(c.operation, c.input);
      const { 'encoding-type': _enc, ...query } = r.query;
      // La longueur du corps XML d'une suppression groupée n'est pas comparée : le document n'est pas écrit mot pour
      // mot comme celui du SDK (même sens, Content-MD5 au lieu d'une somme CRC32).
      const keep = ['content-type', 'cache-control', 'range', 'x-amz-meta-auteur', ...(c.operation === 'deleteObjects' ? [] : ['content-length'])];
      const headers = Object.fromEntries(Object.entries(r.headers).filter(([k]) => keep.includes(k)));
      if (c.operation === 'listObjects' && _enc !== 'url') return 'encoding-type absent';
      return { method: r.method, protocol: r.protocol, hostname: r.hostname, port: r.port, path: r.path, query, headers };
    });
  });

  test(`liens de getSignedUrl sur ${reference.presignCases.length} cas : même adresse et mêmes paramètres, sauf les écarts voulus`, async () => {
    // Écarts voulus : le SDK ajoute x-id, x-amz-checksum-mode, et pour un dépôt une somme CRC32 du corps VIDE
    // (x-amz-checksum-crc32=AAAAAA==, qui fait échouer un vrai dépôt) sans signer le type de contenu ; ici le type
    // est signé (le navigateur ne peut pas en déposer un autre) et aucune somme n'est ajoutée.
    const extras = new Set(['x-id', 'x-amz-checksum-mode', 'x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'X-Amz-Signature', 'X-Amz-SignedHeaders']);
    await assertVectors(reference.presignCases.map((c, i) => ({ id: `getSignedUrl ${i} ${c.input.method || 'GET'}`, input: c, expected: (() => {
      const url = new URL(c.url);
      return { origin: url.origin, path: url.pathname, query: Object.fromEntries([...url.searchParams].filter(([k]) => !extras.has(k))) };
    })() })), (c) => {
      const client = createS3Client({ ...Object.fromEntries(Object.entries(c.setup).filter(([, v]) => v !== undefined)), ...c.credentials, now: () => Date.parse(c.date) });
      const url = new URL(client.presignUrl(c.input));
      const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
      if (signedHeaders !== (c.input.contentType ? 'content-type;host' : 'host')) return `en-têtes signés : ${signedHeaders}`;
      return { origin: url.origin, path: url.pathname, query: Object.fromEntries([...url.searchParams].filter(([k]) => !extras.has(k))) };
    });
  });

  describe('lecture des réponses', () => {
    let server;
    let answer = { status: 200, body: '' };
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => res.writeHead(answer.status, { 'content-type': 'application/xml', 'x-amz-request-id': 'REQ123' }).end(req.method === 'HEAD' ? undefined : answer.body));
      });
      await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    });
    afterAll(() => new Promise((ok) => server.close(ok)));
    const client = () => createS3Client({ endpoint: `http://127.0.0.1:${server.address().port}`, region: 'us-east-1', bucket: 'essai', ...CREDS });

    test(`mêmes résultats que le SDK sur ${reference.responseCases.length} réponses (listes, suppression groupée, erreurs), sauf un écart voulu`, async () => {
      const intended = { 'en-tête refusé sans corps': { name: 'Forbidden', httpStatusCode: 403, fault: 'client' } }; // le SDK dit « Unknown »
      await assertVectors(reference.responseCases.map((c) => ({ id: c.id, input: c, expected: intended[c.id] || c.result })), async (c) => {
        answer = { status: c.status, body: c.body };
        if (c.kind === 'list') {
          const r = await client().listObjects({});
          return { objects: r.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag, lastModified: o.lastModified.toISOString() })), prefixes: r.prefixes, isTruncated: r.isTruncated, nextContinuationToken: r.nextContinuationToken ?? null, keyCount: r.keyCount };
        }
        if (c.kind === 'deleteObjects') return client().deleteObjects({ keys: ['a.txt'] });
        const call = { getObject: () => client().getObject({ key: 'k' }), putObject: () => client().putObject({ key: 'k', body: 'x' }), listObjects: () => client().listObjects({}), headObject: () => client().headObject({ key: 'k' }) }[c.operation];
        const error = await call().then(() => null, (e) => e);
        return error && { name: error.name, httpStatusCode: error.$metadata.httpStatusCode, fault: error.$fault };
      });
    });
  });
});

/* Un vrai service S3 : S3_TEST_ENDPOINT, S3_TEST_ACCESS_KEY, S3_TEST_SECRET_KEY, S3_TEST_BUCKET (SeaweedFS, MinIO, R2…). */
const live = process.env.S3_TEST_ENDPOINT ? describe : describe.skip;
live('un vrai service S3', () => {
  const config = { endpoint: process.env.S3_TEST_ENDPOINT, region: process.env.S3_TEST_REGION || 'us-east-1', accessKeyId: process.env.S3_TEST_ACCESS_KEY, secretAccessKey: process.env.S3_TEST_SECRET_KEY, bucket: process.env.S3_TEST_BUCKET || 'essai-astratra' };
  let s3;
  beforeAll(() => {
    s3 = createS3Client(config);
  });
  const prefix = `essai-${Date.now()}-${crypto.randomBytes(4).toString('hex')}/`;
  // SeaweedFS range les objets comme des fichiers : il refuse un segment de plus de 255 octets et change « a//b » en
  // « a/b » et « \\ » en « / » (AWS et R2 gardent ces clés telles quelles). Ces clés-là ne sont essayées qu'ailleurs.
  const fileLike = process.env.S3_TEST_FILE_LIKE !== '0';
  const KEYS = [...new Set(reference.clientCases.map((c) => c.input.key).filter(Boolean))].filter((k) => !fileLike || (k.split('/').every((s) => Buffer.byteLength(s) <= 255) && !k.includes('//') && !k.includes('\\')));
  afterAll(async () => {
    const keys = [];
    for await (const o of s3.iterateObjects({ prefix })) keys.push(o.key);
    for (let i = 0; i < keys.length; i += 1000) await s3.deleteObjects({ keys: keys.slice(i, i + 1000) });
  });

  test(`chaque clé difficile (${KEYS.length}) fait l’aller-retour : dépôt, lecture, en-têtes, liste`, async () => {
    for (const key of KEYS) {
      const body = Buffer.from(`contenu de ${key}`);
      const put = await s3.putObject({ key: prefix + key, body, contentType: 'text/plain; charset=utf-8', cacheControl: 'public, max-age=60', metadata: { auteur: 'essai' } });
      expect(put.etag).toBe(crypto.createHash('md5').update(body).digest('hex'));
      const got = await s3.getObject({ key: prefix + key });
      expect(got.body.equals(body)).toBe(true);
      expect(got).toEqual(expect.objectContaining({ contentType: 'text/plain; charset=utf-8', contentLength: body.length, metadata: { auteur: 'essai' } }));
      expect((await s3.headObject({ key: prefix + key })).etag).toBe(put.etag);
    }
    const listed = [];
    for await (const o of s3.iterateObjects({ prefix })) listed.push(o.key);
    expect(listed.sort()).toEqual(KEYS.map((k) => prefix + k).sort());
  });

  test('pages de liste, préfixes communs, plage, flux d’un gros objet, plafond en mémoire', async () => {
    for (let i = 0; i < 7; i++) await s3.putObject({ key: `${prefix}pages/${i}.txt`, body: String(i) });
    await s3.putObject({ key: `${prefix}pages/sous/x.txt`, body: 'x' });
    const first = await s3.listObjects({ prefix: `${prefix}pages/`, maxKeys: 3 });
    expect(first.objects).toHaveLength(3);
    expect(first.isTruncated).toBe(true);
    const second = await s3.listObjects({ prefix: `${prefix}pages/`, maxKeys: 3, continuationToken: first.nextContinuationToken });
    expect(second.objects[0].key > first.objects[2].key).toBe(true);
    const grouped = await s3.listObjects({ prefix: `${prefix}pages/`, delimiter: '/' });
    expect(grouped.prefixes).toEqual([`${prefix}pages/sous/`]);
    const big = crypto.randomBytes(5 * 1024 * 1024 + 123);
    await s3.putObject({ key: `${prefix}gros.bin`, body: big });
    expect((await s3.getObject({ key: `${prefix}gros.bin`, range: 'bytes=1000-1999' })).body.equals(big.subarray(1000, 2000))).toBe(true);
    const { stream, contentLength } = await s3.getObjectStream({ key: `${prefix}gros.bin` });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(contentLength).toBe(big.length);
    expect(Buffer.concat(chunks).equals(big)).toBe(true);
    await expect(s3.getObject({ key: `${prefix}gros.bin`, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ name: 'ObjectTooLarge' });
  }, 60_000);

  test('absent, condition, suppression, suppression groupée', async () => {
    await expect(s3.getObject({ key: `${prefix}absent` })).rejects.toMatchObject({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    await expect(s3.headObject({ key: `${prefix}absent` })).rejects.toMatchObject({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    await s3.putObject({ key: `${prefix}unique.txt`, body: 'a', ifNoneMatch: '*' });
    await expect(s3.putObject({ key: `${prefix}unique.txt`, body: 'b', ifNoneMatch: '*' })).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    await s3.deleteObject({ key: `${prefix}unique.txt` });
    await expect(s3.headObject({ key: `${prefix}unique.txt` })).rejects.toMatchObject({ name: 'NotFound' });
    await s3.deleteObject({ key: `${prefix}jamais-existe` });
    await s3.putObject({ key: `${prefix}g1`, body: '1' });
    await s3.putObject({ key: `${prefix}g&2<>`, body: '2' });
    const r = await s3.deleteObjects({ keys: [`${prefix}g1`, `${prefix}g&2<>`] });
    expect(r.deleted.sort()).toEqual([`${prefix}g&2<>`, `${prefix}g1`]);
    expect(r.errors).toEqual([]);
  });

  test('liens signés : lecture, dépôt par un navigateur au type imposé, lien expiré, lien modifié', async () => {
    await s3.putObject({ key: `${prefix}lien é.txt`, body: 'par lien', contentType: 'text/plain' });
    const get = s3.presignUrl({ key: `${prefix}lien é.txt`, expiresIn: 60, responseContentDisposition: 'attachment; filename="x.txt"' });
    const r = await fetch(get);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('par lien');
    const put = s3.presignUrl({ key: `${prefix}depot.webp`, method: 'PUT', contentType: 'image/webp', expiresIn: 60 });
    expect((await fetch(put, { method: 'PUT', headers: { 'content-type': 'image/webp' }, body: 'RIFF' })).status).toBe(200);
    expect((await fetch(put, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<script>' })).status).toBe(403);
    expect((await s3.getObject({ key: `${prefix}depot.webp` })).body.toString()).toBe('RIFF');
    const expired = createS3Client({ ...config, now: () => Date.now() - 120_000 }).presignUrl({ key: `${prefix}lien é.txt`, expiresIn: 60 });
    expect((await fetch(expired)).status).toBe(403);
    const other = new URL(get);
    other.pathname = other.pathname.replace('lien%20%C3%A9', 'autre');
    expect((await fetch(other)).status).toBe(403);
  });

  test('une mauvaise clé secrète : refusé par le service (SignatureDoesNotMatch)', async () => {
    await expect(createS3Client({ ...config, secretAccessKey: 'fausse' }).getObject({ key: `${prefix}x` })).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  });
});

describe('attaques', () => {
  let server;
  let handler = (req, res) => res.writeHead(200).end();
  const requests = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      handler(req, res);
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  });
  beforeEach(() => {
    requests.length = 0;
  });
  const client = (extra = {}) => createS3Client({ endpoint: `http://127.0.0.1:${server.address().port}`, region: 'us-east-1', bucket: 'essai', ...CREDS, ...extra });

  test('un objet plus grand que maxBytes est refusé, annoncé ou non, sans tout lire', async () => {
    handler = (req, res) => res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) }).end(Buffer.alloc(1024));
    await expect(client().getObject({ key: 'k', maxBytes: 1024 * 1024 })).rejects.toMatchObject({ name: 'ObjectTooLarge' });
    handler = (req, res) => {
      res.writeHead(200);
      const pump = () => {
        while (!res.destroyed && res.write(Buffer.alloc(64 * 1024))) {
          // écrire tant que le client lit
        }
        if (!res.destroyed) res.once('drain', pump);
      };
      pump();
    };
    const started = Date.now();
    await expect(client().getObject({ key: 'k', maxBytes: 1024 * 1024 })).rejects.toMatchObject({ name: 'ObjectTooLarge' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('une réponse d’erreur immense est coupée, une réponse muette abandonnée, une redirection jamais suivie', async () => {
    handler = (req, res) => {
      res.writeHead(500);
      const pump = () => {
        while (!res.destroyed && res.write(Buffer.alloc(64 * 1024, 0x61))) {
          // écrire tant que le client lit
        }
        if (!res.destroyed) res.once('drain', pump);
      };
      pump();
    };
    await expect(client().getObject({ key: 'k' })).rejects.toMatchObject({ name: 'InternalError', $metadata: { httpStatusCode: 500 } });
    handler = () => {};
    const started = Date.now();
    await expect(client({ timeoutMs: 300 }).getObject({ key: 'k' })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(3000);
    handler = (req, res) => res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data' }).end();
    await expect(client().getObject({ key: 'k' })).rejects.toMatchObject({ name: 'TemporaryRedirect' });
    expect(requests).toHaveLength(3);
  });

  test('une liste aux clés encodées (encoding-type=url) est décodée ; un encodage cassé est refusé', async () => {
    const list = (keys) => `<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('')}<CommonPrefixes><Prefix>dossier+%C3%A9%2F</Prefix></CommonPrefixes></ListBucketResult>`;
    handler = (req, res) => res.writeHead(200).end(list(['mon+fichier%2B%C3%A9.txt', 'ligne%0Abis']));
    const r = await client().listObjects({});
    expect(r.objects.map((o) => o.key)).toEqual(['mon fichier+é.txt', 'ligne\nbis']);
    expect(r.prefixes).toEqual(['dossier é/']);
    expect(new URL(`http://x${requests[0].url}`).searchParams.get('encoding-type')).toBe('url');
    handler = (req, res) => res.writeHead(200).end(list(['%E9%']));
    await expect(client().listObjects({})).rejects.toMatchObject({ name: 'InvalidResponse' });
  });

  test('XML piégé (DOCTYPE, entités, profondeur, taille) : refusé, jamais développé', async () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><ListBucketResult><Name>&lol2;</Name></ListBucketResult>';
    const xxe = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><ListBucketResult><Name>&xxe;</Name></ListBucketResult>';
    for (const body of [bomb, xxe, `<ListBucketResult>${'<a>'.repeat(100)}${'</a>'.repeat(100)}</ListBucketResult>`, '<ListBucketResult><Name>&inconnue;</Name></ListBucketResult>', `<ListBucketResult>${'<Contents><Key>k</Key></Contents>'.repeat(40000)}</ListBucketResult>`]) {
      handler = (req, res) => res.writeHead(200).end(body);
      await expect(client().listObjects({})).rejects.toBeInstanceOf(Error);
    }
    expect(() => parseXml(bomb)).toThrow(XmlError);
    expect(() => parseXml(xxe)).toThrow(/DOCTYPE/);
  });

  test('le lecteur XML rend tout texte échappé à l’identique (propriété), et toute entrée donne un arbre ou une XmlError (fuzz)', async () => {
    await assertProperty(gen.string({ max: 300, alphabet: 'unicode' }), (text) => {
      // Seuls les caractères permis en XML 1.0 (pas de contrôle sauf tabulation et retours, pas de demi-caractère).
      const clean = [...text].filter((ch) => {
        const code = ch.codePointAt(0);
        return (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff;
      }).join('');
      return textOf(parseXml(`<a><b>${escapeXml(clean)}</b></a>`), 'b') === clean;
    }, { runs: 500 });
    await assertFuzz((text) => {
      try {
        return parseXml(text);
      } catch (error) {
        if (error instanceof XmlError) throw Object.assign(error, { status: 400 });
        throw error;
      }
    }, { generator: gen.oneOf(gen.hostileString(), gen.string({ max: 400, alphabet: '<>/!?&;#x="\' abAB' })), runs: 2000 });
  });

  test('clés, compartiments et adresses piégés : refusés avant tout envoi', () => {
    const c = client();
    for (const key of ['', '/absolu', '../hors', 'a/../b', 'a/./b', '.', '..', 'nul\u0000', 'retour\r\nX: y', 'tab\tulation', 'é'.repeat(513), '\ud800seul']) {
      expect(() => c.describeRequest('getObject', { key })).toThrow(S3Error);
    }
    for (const bucket of ['AB', 'a', 'a'.repeat(64), 'avec_souligné', '-tiret', 'point..double', '192.168.0.1', 'x/y', '../x']) {
      expect(() => c.describeRequest('getObject', { bucket, key: 'k' })).toThrow(/bucket/);
    }
    for (const endpoint of ['http://s3.example.test', 'ftp://x.test', 'https://user:pass@x.test', 'https://x.test/chemin', 'https://x.test?a=b', 'pas une adresse']) {
      expect(() => createS3Client({ endpoint, ...CREDS })).toThrow(S3Error);
    }
    expect(() => createS3Client({ ...CREDS })).toThrow(/endpoint/);
    expect(() => createS3Client({ endpoint: 'https://x.test', accessKeyId: 'a/b', secretAccessKey: 's' })).toThrow(/accessKeyId/);
    expect(c.describeRequest('getObject', { key: 'a//b c' }).path).toBe('/essai/a//b%20c');
  });

  test('injection d’en-tête : type, cache, métadonnées et plage piégés sont refusés', () => {
    const c = client();
    for (const input of [{ contentType: 'text/plain\r\nX-Evil: 1' }, { cacheControl: 'a\nb' }, { metadata: { 'nom espace': 'x' } }, { metadata: { ok: 'valeur\r\n' } }, { metadata: { ok: 'é' } }, { metadata: { ok: 'x'.repeat(3000) } }, { metadata: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`m${i}`, 'v'.repeat(100)])) }, { ifNoneMatch: 'abc' }]) {
      expect(() => c.describeRequest('putObject', { key: 'k', body: 'x', ...input })).toThrow(S3Error);
    }
    for (const range of ['bytes=', 'bytes=-', 'bytes=5-1', 'bytes=0-1,5-9', 'octets=0-1', 'bytes=0-1\r\nX: y', 42]) {
      expect(() => c.describeRequest('getObject', { key: 'k', range })).toThrow(/range/);
    }
    expect(() => c.presignUrl({ key: 'k', expiresIn: 604_801 })).toThrow(/7 days/);
    expect(() => c.presignUrl({ key: 'k', method: 'POST' })).toThrow(/method/);
  });

  test('le fuzz : toute entrée donne une requête signée ou une S3Error, et le secret n’apparaît jamais', async () => {
    const c = client();
    await assertFuzz((input) => {
      try {
        const r = c.describeRequest(input.operation, input.value);
        if (JSON.stringify(r).includes(CREDS.secretAccessKey)) throw new Error('secret dans la requête');
        return r;
      } catch (error) {
        if (error instanceof S3Error) {
          if (error.message.includes(CREDS.secretAccessKey)) throw new Error('secret dans une erreur', { cause: error });
          throw Object.assign(error, { status: 400 });
        }
        throw error;
      }
    }, { generator: gen.record({ operation: gen.elements(['putObject', 'getObject', 'headObject', 'deleteObject', 'deleteObjects', 'listObjects', 'inconnue', '__proto__']), value: gen.oneOf(gen.json(), gen.record({ key: gen.hostileString(), body: gen.hostileString(), contentType: gen.hostileString(), range: gen.hostileString(), prefix: gen.hostileString(), keys: gen.array(gen.hostileString(), { max: 5 }), metadata: gen.json() })) }), runs: 1500 });
  });

  test('aucune expression régulière du paquet ne s’emballe', async () => {
    for (const file of ['client.js', 'sigv4.js', 'xml.js']) {
      for (const regex of extractRegexLiterals(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'))) await assertSafeRegex(regex);
    }
  });
});
