'use strict';

/*
 * Enregistre, une fois, ce que fait le SDK AWS v3 (@aws-sdk/client-s3, @aws-sdk/s3-request-presigner,
 * @smithy/signature-v4) pour comparer le client S3 d'Astratra (__tests__/fixtures/aws-sdk-reference.json). Le SDK
 * n'est pas une dépendance d'Astratra : le dossier d'un projet qui l'a installé est donné en argument.
 *   node scripts/record-aws-sdk-reference.cjs /chemin/vers/un/projet
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const { createRandom } = require('@astratra/testkit/security');
const { encodePath } = require('../src/sigv4');

const project = createRequire(path.join(path.resolve(process.argv[2]), 'package.json'));
const s3 = project('@aws-sdk/client-s3');
const { getSignedUrl } = project('@aws-sdk/s3-request-presigner');
const { SignatureV4 } = project('@smithy/signature-v4');
const { HttpResponse } = project('@smithy/core/protocols');
const version = (name) => project(`${name}/package.json`).version;

class Sha256 {
  constructor(secret) {
    this.hash = secret ? crypto.createHmac('sha256', secret) : crypto.createHash('sha256');
  }
  update(data) {
    this.hash.update(typeof data === 'string' ? Buffer.from(data) : data);
  }
  async digest() {
    return new Uint8Array(this.hash.digest());
  }
}

const random = createRandom('aws-sdk-reference');
const pick = (list) => list[random.int(0, list.length - 1)];
// Des identifiants visiblement faux (ni préfixe AKIA, ni valeur au hasard) : un analyseur de secrets comme gitleaks ne
// doit pas les prendre pour une fuite. La signature change avec chacun, c'est tout ce qui compte ici.
let credentialCount = 0;
const credentialsOf = (withToken) => {
  const n = String(++credentialCount).padStart(4, '0');
  return { accessKeyId: `ESSAI${n}CLEFAUSSE`, secretAccessKey: `secret-essai-${n}`, ...(withToken ? { sessionToken: `jeton-essai-${n}` } : {}) };
};
const KEYS = ['photo.jpg', 'a/b/c.txt', 'é b.txt', 'x+y=z&w.txt', "(parenthèses)!*'.txt", 'tilde~et_point.-', '100% vrai.txt', 'emoji 🎉.txt', 'espace  double', 'a//b', 'medias/produits/42-400.webp', '日本語/ファイル.pdf', 'clé?avec#signes', 'deux:points;et,virgules', '[crochets]{accolades}', 'barre\\inverse', '"guillemets".txt', 'é'.repeat(300)];
const REGIONS = ['us-east-1', 'eu-west-3', 'auto', 'af-south-1'];
const randomDate = () => new Date(Date.UTC(2020 + random.int(0, 9), random.int(0, 11), random.int(1, 28), random.int(0, 23), random.int(0, 59), random.int(0, 59)));

// A. Le signataire seul : mêmes entrées, l'en-tête Authorization et les paramètres d'un lien signé.
async function signerCases() {
  const out = [];
  for (let i = 0; i < 160; i++) {
    const credentials = credentialsOf(i % 5 === 0);
    const region = pick(REGIONS);
    const date = randomDate();
    const method = pick(['GET', 'PUT', 'HEAD', 'DELETE', 'POST']);
    const host = pick(['examplebucket.s3.amazonaws.com', 'compte.r2.cloudflarestorage.com', '127.0.0.1:9000', 's3.eu-west-3.amazonaws.com']);
    const encoded = `/${encodePath(pick(KEYS))}`;
    const query = {};
    for (const [k, v] of [['prefix', pick(KEYS)], ['delimiter', '/'], ['continuation-token', crypto.randomBytes(12).toString('base64')], ['max-keys', String(random.int(1, 1000))], ['list-type', '2'], ['encoding-type', 'url'], ['delete', ''], ['response-content-disposition', 'attachment; filename="é.txt"']]) if (random.int(0, 3) === 0) query[k] = v;
    const headers = { host };
    if (random.int(0, 1)) headers['content-type'] = pick(['text/plain', 'image/webp', 'application/octet-stream', 'text/plain; charset=utf-8']);
    if (random.int(0, 2) === 0) headers.range = `bytes=${random.int(0, 99)}-${random.int(100, 999)}`;
    if (random.int(0, 2) === 0) headers['x-amz-meta-auteur'] = pick(['essai', '  espaces  au  milieu  ', 'a b']);
    if (random.int(0, 2) === 0) headers['cache-control'] = 'public, max-age=60';
    if (random.int(0, 3) === 0) headers['content-md5'] = crypto.randomBytes(16).toString('base64');
    const payloadHash = random.int(0, 3) === 0 ? 'UNSIGNED-PAYLOAD' : crypto.createHash('sha256').update(crypto.randomBytes(random.int(0, 64))).digest('hex');
    const signer = new SignatureV4({ credentials, region, service: 's3', sha256: Sha256, uriEscapePath: false, applyChecksum: true });
    const signed = await signer.sign({ method, protocol: 'https:', hostname: host, path: encoded, query: { ...query }, headers: { ...headers, 'x-amz-content-sha256': payloadHash } }, { signingDate: date });
    const presignHeaders = { host };
    if (method === 'PUT' && random.int(0, 1)) presignHeaders['content-type'] = 'image/webp';
    if (method === 'PUT' && random.int(0, 2) === 0) presignHeaders['content-length'] = String(random.int(1, 1e7));
    const expiresIn = pick([1, 60, 900, 3600, 604800]);
    const presigned = await signer.presign({ method, protocol: 'https:', hostname: host, path: encoded, query: { ...query }, headers: { ...presignHeaders, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } }, { signingDate: date, expiresIn });
    out.push({ credentials, region, date: date.toISOString(), method, path: encoded, query, headers, payloadHash, authorization: signed.headers.authorization, presign: { headers: presignHeaders, expiresIn, query: presigned.query } });
  }
  return out;
}

// B. Le client complet : la requête construite par chaque commande (sans l'envoyer).
async function clientCases() {
  const out = [];
  const setups = [
    { id: 'R2', config: { region: 'auto', endpoint: 'https://compte.r2.cloudflarestorage.com' }, ours: { region: 'auto', endpoint: 'https://compte.r2.cloudflarestorage.com' } },
    { id: 'R2 chemin', config: { region: 'auto', endpoint: 'https://compte.r2.cloudflarestorage.com', forcePathStyle: true }, ours: { region: 'auto', endpoint: 'https://compte.r2.cloudflarestorage.com', forcePathStyle: true } },
    { id: 'AWS', config: { region: 'eu-west-3' }, ours: { region: 'eu-west-3' } },
    { id: 'local', config: { region: 'us-east-1', endpoint: 'http://127.0.0.1:9000', forcePathStyle: true }, ours: { region: 'us-east-1', endpoint: 'http://127.0.0.1:9000' } },
  ];
  for (const setup of setups) {
    let captured;
    const client = new s3.S3Client({ ...setup.config, credentials: credentialsOf(false), requestHandler: { handle: async (request) => { captured = request; throw new Error('capturé'); } }, maxAttempts: 1 });
    const bucket = pick(['photos-essai', 'medias', 'abc']);
    const commands = [];
    for (const key of KEYS) {
      commands.push(['putObject', { bucket, key, body: 'contenu', contentType: 'text/plain', cacheControl: 'public, max-age=60', metadata: { auteur: 'essai' } }, new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: 'contenu', ContentType: 'text/plain', CacheControl: 'public, max-age=60', Metadata: { auteur: 'essai' } })]);
      commands.push(['getObject', { bucket, key, range: 'bytes=0-9' }, new s3.GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-9' })]);
      commands.push(['headObject', { bucket, key }, new s3.HeadObjectCommand({ Bucket: bucket, Key: key })]);
      commands.push(['deleteObject', { bucket, key }, new s3.DeleteObjectCommand({ Bucket: bucket, Key: key })]);
    }
    commands.push(['listObjects', { bucket, prefix: 'a/', delimiter: '/', maxKeys: 50, continuationToken: 'jeton+/=' }, new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: 'a/', Delimiter: '/', MaxKeys: 50, ContinuationToken: 'jeton+/=' })]);
    commands.push(['listObjects', { bucket }, new s3.ListObjectsV2Command({ Bucket: bucket })]);
    commands.push(['deleteObjects', { bucket, keys: ['a.txt', 'b&c<d>.txt'] }, new s3.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: 'a.txt' }, { Key: 'b&c<d>.txt' }], Quiet: false } })]);
    for (const [operation, input, command] of commands) {
      captured = undefined;
      await client.send(command).catch(() => {});
      const keep = ['content-type', 'cache-control', 'range', 'x-amz-meta-auteur', 'content-length'];
      const headers = Object.fromEntries(Object.entries(captured.headers).map(([k, v]) => [k.toLowerCase(), String(v)]).filter(([k]) => keep.includes(k)));
      out.push({ setup: setup.id, ours: setup.ours, operation, input, request: { method: captured.method, protocol: captured.protocol, hostname: captured.hostname, port: captured.port ?? null, path: captured.path, query: captured.query, headers } });
    }
  }
  return out;
}

// C. Les liens signés de getSignedUrl.
async function presignCases() {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const credentials = credentialsOf(i % 4 === 0);
    const setup = pick([{ region: 'auto', endpoint: 'https://compte.r2.cloudflarestorage.com' }, { region: 'eu-west-3' }, { region: 'us-east-1', endpoint: 'http://127.0.0.1:9000', forcePathStyle: true }]);
    const client = new s3.S3Client({ ...setup, credentials });
    const key = pick(KEYS);
    const bucket = 'liens-essai';
    const expiresIn = pick([60, 900, 3600, 604800]);
    const date = randomDate();
    const put = i % 3 === 0;
    const input = put ? { bucket, key, method: 'PUT', contentType: 'image/webp', expiresIn } : { bucket, key, expiresIn, ...(i % 5 === 1 ? { responseContentDisposition: 'attachment; filename="photo.jpg"' } : {}) };
    const command = put ? new s3.PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'image/webp' }) : new s3.GetObjectCommand({ Bucket: bucket, Key: key, ...(input.responseContentDisposition ? { ResponseContentDisposition: input.responseContentDisposition } : {}) });
    const url = await getSignedUrl(client, command, { expiresIn, signingDate: date });
    out.push({ credentials, setup: { ...setup, forcePathStyle: undefined }, date: date.toISOString(), input, url });
  }
  return out;
}

// D. La lecture des réponses : ce que le SDK tire de réponses XML (listes, suppressions groupées, erreurs).
async function responseCases() {
  const out = [];
  const xmlKey = (k) => k.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const listXml = ({ keys, prefixes = [], truncated = false, token, pretty = false, declaration = true, entities = false }) => {
    const nl = pretty ? '\n  ' : '';
    const contents = keys.map((k, i) => `${nl}<Contents><Key>${entities ? xmlKey(k).replace(/é/g, '&#xE9;').replace(/ /g, '&#32;') : xmlKey(k)}</Key><LastModified>2026-0${(i % 9) + 1}-1${i % 10}T0${i % 10}:3${i % 10}:00.000Z</LastModified><ETag>&quot;${crypto.createHash('md5').update(k).digest('hex')}&quot;</ETag><Size>${(i + 1) * 137}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('');
    const common = prefixes.map((p) => `${nl}<CommonPrefixes><Prefix>${xmlKey(p)}</Prefix></CommonPrefixes>`).join('');
    return `${declaration ? '<?xml version="1.0" encoding="UTF-8"?>\n' : ''}<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${nl}<Name>essai</Name><Prefix></Prefix><KeyCount>${keys.length + prefixes.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${truncated}</IsTruncated>${token ? `<NextContinuationToken>${xmlKey(token)}</NextContinuationToken>` : ''}${contents}${common}${pretty ? '\n' : ''}</ListBucketResult>`;
  };
  const bodies = [
    ['liste simple', 200, listXml({ keys: ['a.txt', 'b/c.txt'] })],
    ['liste vide', 200, listXml({ keys: [] })],
    ['liste mise en forme', 200, listXml({ keys: ['x', 'y z'], pretty: true })],
    ['liste sans déclaration', 200, listXml({ keys: ['x'], declaration: false })],
    ['clés à échapper', 200, listXml({ keys: ['a&b.txt', '<script>.txt', '"guillemets".txt', "l'apostrophe"] })],
    ['références numériques', 200, listXml({ keys: ['élève b.txt'], entities: true })],
    ['espaces en bord de clé', 200, listXml({ keys: ['  deux espaces avant', 'après  '] })],
    ['unicode', 200, listXml({ keys: ['日本語/ファイル.pdf', 'emoji 🎉.txt'] })],
    ['préfixes communs', 200, listXml({ keys: ['a/x'], prefixes: ['a/b/', 'a/c&d/'] })],
    ['tronquée', 200, listXml({ keys: ['k1', 'k2'], truncated: true, token: 'suite-de-la-liste-0001' })],
  ];
  for (let i = 0; i < 20; i++) bodies.push([`au hasard ${i}`, 200, listXml({ keys: Array.from({ length: random.int(0, 30) }, () => pick(KEYS)), prefixes: random.int(0, 1) ? [pick(KEYS)] : [], truncated: i % 3 === 0, token: i % 3 === 0 ? crypto.randomBytes(20).toString('base64') : undefined, pretty: i % 2 === 0 })]);
  const errors = [
    ['objet absent', 404, '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>absent.txt</Key><RequestId>4442587FB7D0A2F9</RequestId></Error>', 'getObject'],
    ['accès refusé', 403, '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message><RequestId>ABC</RequestId></Error>', 'getObject'],
    ['signature fausse', 403, '<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message></Error>', 'putObject'],
    ['compartiment absent', 404, '<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message><BucketName>x</BucketName></Error>', 'listObjects'],
    ['panne', 503, '<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>', 'getObject'],
    ['condition', 412, '<Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>', 'putObject'],
    ['en-tête absent sans corps', 404, '', 'headObject'],
    ['en-tête refusé sans corps', 403, '', 'headObject'],
  ];
  const deleteXml = '<?xml version="1.0" encoding="UTF-8"?><DeleteResult><Deleted><Key>a.txt</Key></Deleted><Deleted><Key>b&amp;c.txt</Key></Deleted><Error><Key>c.txt</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error></DeleteResult>';

  const respond = (status, body) => ({ handle: async () => ({ response: new HttpResponse({ statusCode: status, headers: { 'content-type': 'application/xml', 'x-amz-request-id': 'REQ123' }, body: Readable.from([Buffer.from(body)]) }) }) });
  const credentials = credentialsOf(false);
  for (const [id, status, body] of bodies) {
    const client = new s3.S3Client({ region: 'us-east-1', credentials, requestHandler: respond(status, body), maxAttempts: 1 });
    const r = await client.send(new s3.ListObjectsV2Command({ Bucket: 'essai' }));
    out.push({ id, kind: 'list', status, body, result: { objects: (r.Contents || []).map((c) => ({ key: c.Key, size: c.Size, etag: c.ETag.replace(/"/g, ''), lastModified: c.LastModified.toISOString() })), prefixes: (r.CommonPrefixes || []).map((p) => p.Prefix), isTruncated: r.IsTruncated, nextContinuationToken: r.NextContinuationToken ?? null, keyCount: r.KeyCount } });
  }
  {
    const client = new s3.S3Client({ region: 'us-east-1', credentials, requestHandler: respond(200, deleteXml), maxAttempts: 1 });
    const r = await client.send(new s3.DeleteObjectsCommand({ Bucket: 'essai', Delete: { Objects: [{ Key: 'a.txt' }] } }));
    out.push({ id: 'suppression groupée', kind: 'deleteObjects', status: 200, body: deleteXml, result: { deleted: r.Deleted.map((d) => d.Key), errors: r.Errors.map((e) => ({ key: e.Key, code: e.Code, message: e.Message })) } });
  }
  for (const [id, status, body, operation] of errors) {
    const client = new s3.S3Client({ region: 'us-east-1', credentials, requestHandler: respond(status, body), maxAttempts: 1 });
    const command = { getObject: () => new s3.GetObjectCommand({ Bucket: 'essai', Key: 'k' }), putObject: () => new s3.PutObjectCommand({ Bucket: 'essai', Key: 'k', Body: 'x' }), listObjects: () => new s3.ListObjectsV2Command({ Bucket: 'essai' }), headObject: () => new s3.HeadObjectCommand({ Bucket: 'essai', Key: 'k' }) }[operation]();
    const error = await client.send(command).then(() => null, (e) => e);
    out.push({ id, kind: 'error', operation, status, body, result: { name: error.name, httpStatusCode: error.$metadata.httpStatusCode, fault: error.$fault } });
  }
  return out;
}

(async () => {
  const out = {
    source: `@aws-sdk/client-s3 ${version('@aws-sdk/client-s3')}, @aws-sdk/s3-request-presigner ${version('@aws-sdk/s3-request-presigner')}, @smithy/signature-v4 ${version('@smithy/signature-v4')}`,
    signerCases: await signerCases(),
    clientCases: await clientCases(),
    presignCases: await presignCases(),
    responseCases: await responseCases(),
  };
  fs.mkdirSync(path.join(__dirname, '../__tests__/fixtures'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../__tests__/fixtures/aws-sdk-reference.json'), `${JSON.stringify(out, null, 1)}\n`);
  process.stdout.write(`${out.signerCases.length} signatures, ${out.clientCases.length} requêtes, ${out.presignCases.length} liens, ${out.responseCases.length} réponses (${out.source}).\n`);
})();
