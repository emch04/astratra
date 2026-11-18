/* global FormData, Blob, fetch */
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const {
  payloads, gen, createRandom, assertFuzz, assertBounded, assertSafeRegex, extractRegexLiterals, assertProperty, assertVectors,
} = require('@astratra/testkit/security');
const { createUpload, detectFileType, safeFileName, UploadError } = require('../src');

// Le lecteur de téléversements (src/upload.js), sans multer ni busboy : comparé aux réponses enregistrées de
// multer 2.4.0, puis essayé pour de vrai par HTTP, morceau par morceau, et sous attaque.

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/multer-reference.json'), 'utf8'));
const B = reference.boundary;
const CT = `multipart/form-data; boundary=${B}`;

/** Un serveur d'essai : le middleware, puis le résultat (ou l'erreur) en JSON. */
async function withServer(middleware, run) {
  const server = http.createServer((req, res) => middleware(req, res, (error) => {
    const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : req.files ? Object.values(req.files).flat() : [];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(error ? { error: error.code || error.message, status: error.status } : {
      body: req.body && Object.fromEntries(Object.entries(req.body)),
      files: files.map((f) => ({ fieldname: f.fieldname, originalname: f.originalname, encoding: f.encoding, mimetype: f.mimetype, size: f.size, sha256: crypto.createHash('sha256').update(f.buffer).digest('hex') })),
    }));
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Envoie un corps, d'un coup ou en morceaux de `chunk` octets (frontières coupées entre deux morceaux). */
function send(url, body, { contentType = CT, chunk } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': contentType, ...(chunk ? {} : { 'content-length': body.length }) } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject);
    if (!chunk) req.end(body);
    else {
      for (let i = 0; i < body.length; i += chunk) req.write(body.subarray(i, i + chunk));
      req.end();
    }
  });
}

const part = (headers, content) => `--${B}\r\n${headers.join('\r\n')}\r\n\r\n${content}\r\n`;
const field = (name, value) => part([`Content-Disposition: form-data; name="${name}"`], value);
const file = (name, filename, content, type = 'application/octet-stream') => part([`Content-Disposition: form-data; name="${name}"; filename="${filename}"`, `Content-Type: ${type}`], content);
const close = `--${B}--\r\n`;
const handlerFor = (c) => {
  const [mode, ...args] = c.mode;
  return createUpload({ limits: c.limits })[mode](...args);
};

/* Les écarts voulus avec multer, chacun avec sa raison. */
const INTENDED = {
  'champ exactement à la limite': { why: 'fieldSize est un maximum compris, comme fileSize' },
  'remplissage après la frontière': { why: 'espaces permis avant la fin de ligne (RFC 2046)' },
  'contenu qui ressemble à la frontière': { why: 'un contenu qui commence par la frontière sans CRLF devant est du contenu' },
  'partie sans Content-Disposition': { why: 'RFC 7578 : refusée au lieu d’être ignorée en silence' },
  'nom de champ accentué': { why: 'lu en UTF-8 (multer donne « Ã©lÃ¨ve »)' },
  '__proto__ en nom de champ': { why: 'pollution de prototype : refusé' },
  'constructor en nom de champ': { why: 'pollution de prototype : refusé' },
};

describe(`comparé à ${reference.source}`, () => {
  test('mêmes réponses sur les formulaires nommés, hors écarts voulus', async () => {
    const named = reference.cases.filter((c) => !c.id.startsWith('muté') && !INTENDED[c.id]);
    const category = (o) => (o.error ? (/^(LIMIT_|MISSING_FIELD_NAME)/.test(o.error) ? o.error : 'refusé') : o);
    await assertVectors(named.map((c) => ({ id: c.id, input: c, expected: category(c.expected) })), async (c) => withServer(handlerFor(c), (url) => send(url, Buffer.from(c.body, 'base64'), { contentType: c.contentType })).then((o) => {
      const out = category(o);
      return typeof out === 'object' ? JSON.parse(JSON.stringify({ body: out.body, files: out.files })) : out;
    }), { source: reference.source });
  });

  test('les écarts voulus donnent bien notre réponse', async () => {
    const ours = {};
    for (const c of reference.cases.filter((x) => INTENDED[x.id])) ours[c.id] = await withServer(handlerFor(c), (url) => send(url, Buffer.from(c.body, 'base64'), { contentType: c.contentType }));
    expect(ours['champ exactement à la limite'].body).toEqual({ a: 'y'.repeat(32) });
    expect(ours['nom de champ accentué'].body).toEqual({ élève: 'oui' });
    expect(ours['__proto__ en nom de champ'].error).toBe('FIELD_NAME_FORBIDDEN');
    expect(ours['constructor en nom de champ'].error).toBe('FIELD_NAME_FORBIDDEN');
    expect(ours['partie sans Content-Disposition'].error).toBe('MALFORMED');
  });

  test('corps abîmés : quand multer et le lecteur acceptent tous les deux, le résultat est identique', async () => {
    let both = 0;
    for (const c of reference.cases.filter((x) => x.id.startsWith('muté'))) {
      const ours = await withServer(handlerFor(c), (url) => send(url, Buffer.from(c.body, 'base64'), { contentType: c.contentType }));
      if (ours.error || c.expected.error) continue;
      both += 1;
      // Le type annoncé vient du client (un en-tête abîmé se lit de deux façons) : il n'est pas comparé ici.
      const withoutType = (o) => ({ body: o.body, files: o.files.map(({ mimetype: _type, ...f }) => f) });
      expect({ id: c.id, ours: withoutType(ours) }).toEqual({ id: c.id, ours: withoutType(c.expected) });
    }
    expect(both).toBeGreaterThan(15);
  });
});

describe('usages', () => {
  test('single, array, fields, none, any, avec FormData', async () => {
    const form = new FormData();
    form.append('titre', 'Élève');
    form.append('tags', 'a');
    form.append('tags', 'b');
    form.append('photo', new Blob(['png'], { type: 'image/png' }), 'Été 2026.png');
    const up = createUpload();
    const single = await withServer(up.single('photo'), (url) => fetch(url, { method: 'POST', body: form }).then((r) => r.json()));
    expect(single.body).toEqual({ titre: 'Élève', tags: ['a', 'b'] });
    expect(single.files).toEqual([expect.objectContaining({ fieldname: 'photo', originalname: 'Été 2026.png', mimetype: 'image/png', size: 3 })]);
    const two = new FormData();
    two.append('docs', new Blob(['1']), '1.txt');
    two.append('docs', new Blob(['2']), '2.txt');
    two.append('avatar', new Blob(['3']), '3.txt');
    expect((await withServer(up.array('docs', 2), (url) => fetch(url, { method: 'POST', body: two }).then((r) => r.json()))).error).toBe('LIMIT_UNEXPECTED_FILE');
    const fields = await withServer(up.fields([{ name: 'docs', maxCount: 2 }, { name: 'avatar', maxCount: 1 }]), (url) => fetch(url, { method: 'POST', body: two }).then((r) => r.json()));
    expect(fields.files.map((f) => f.fieldname)).toEqual(['docs', 'docs', 'avatar']);
    expect((await withServer(up.any(), (url) => fetch(url, { method: 'POST', body: two }).then((r) => r.json()))).files).toHaveLength(3);
    expect((await withServer(up.none(), (url) => fetch(url, { method: 'POST', body: two }).then((r) => r.json()))).error).toBe('LIMIT_UNEXPECTED_FILE');
  });

  test('fileFilter : rappel comme multer, ou booléen / promesse ; un refus sans erreur écarte le fichier', async () => {
    const body = Buffer.from(file('f', 'a.png', 'x', 'image/png') + close);
    const cb = createUpload({ fileFilter: (req, f, done) => done(null, f.mimetype === 'image/png') }).single('f');
    expect((await withServer(cb, (url) => send(url, body))).files).toHaveLength(1);
    const no = createUpload({ fileFilter: async () => false }).single('f');
    expect((await withServer(no, (url) => send(url, body))).files).toHaveLength(0);
    const error = createUpload({ fileFilter: (req, f, done) => done(Object.assign(new Error('TYPE_NON_AUTORISE'), { status: 400 })) }).single('f');
    expect((await withServer(error, (url) => send(url, body))).error).toBe('TYPE_NON_AUTORISE');
  });

  test('une requête qui n’est pas du multipart passe telle quelle ; une frontière absente est refusée', async () => {
    const up = createUpload().none();
    const res = { };
    let called = false;
    await up({ headers: { 'content-type': 'application/json' } }, res, (error) => { called = error === undefined; });
    expect(called).toBe(true);
    expect((await withServer(up, (url) => send(url, Buffer.from('x'), { contentType: 'multipart/form-data' }))).error).toBe('MALFORMED');
    expect((await withServer(up, (url) => send(url, Buffer.from('x'), { contentType: 'multipart/form-data; boundary=' + 'b'.repeat(71) }))).error).toBe('MALFORMED');
  });

  test('des limites par défaut existent (multer n’en avait aucune), et chaque limite répond 400 ou 413', async () => {
    const big = Buffer.from(file('f', 'a.bin', 'x'.repeat(10 * 1024 * 1024 + 1)) + close);
    const res = await withServer(createUpload().single('f'), (url) => send(url, big));
    expect(res).toEqual({ error: 'LIMIT_FILE_SIZE', status: 413 });
    expect(() => createUpload({ limits: { fileSize: -1 } })).toThrow(/fileSize/);
    expect(new UploadError('LIMIT_FIELD_COUNT').status).toBe(400);
  });
});

describe('au fil du flux', () => {
  test('propriété : quel que soit le découpage en morceaux, le résultat est le même', async () => {
    const body = Buffer.from(field('a', 'un') + file('f', 'x.bin', `${'\r\n'.repeat(5)}--${B.slice(0, 10)}\r\n-\r` + crypto.randomBytes(300).toString('latin1'), 'application/octet-stream') + field('b', 'deux') + close, 'latin1');
    const up = createUpload().single('f');
    const whole = await withServer(up, (url) => send(url, body));
    expect(whole.files[0].size).toBeGreaterThan(300);
    await withServer(up, async (url) => {
      await assertProperty(gen.integer(1, 80), async (chunk) => {
        const out = await send(url, body, { chunk });
        return JSON.stringify(out) === JSON.stringify(whole);
      }, { runs: 40 });
    });
  });
});

describe('attaques', () => {
  test('un nom de fichier piégé ne donne jamais de chemin dans originalname ni dans safeName', async () => {
    for (const name of payloads.filenames) {
      const safe = safeFileName(name);
      expect({ name, safe, ok: !/[\\/]/.test(safe) && !safe.startsWith('.') && safe.length > 0 && !/^(con|nul|aux)(\.|$)/i.test(safe) }).toEqual({ name, safe, ok: true });
    }
    const body = Buffer.from(file('f', '..\\..\\windows\\evil.bat', 'x') + close);
    const res = await withServer(createUpload().single('f'), (url) => send(url, body));
    expect(res.files[0].originalname).toBe('evil.bat');
  });

  test('en-têtes trop longs, trop nombreux ou répétés : refusés', async () => {
    const up = createUpload().none();
    const long = Buffer.from(part([`Content-Disposition: form-data; name="a"; x="${'y'.repeat(10_000)}"`], 'v') + close);
    expect((await withServer(up, (url) => send(url, long))).error).toBe('HEADER_TOO_LARGE');
    const many = Buffer.from(part(['Content-Disposition: form-data; name="a"', ...Array.from({ length: 30 }, (_, i) => `X-${i}: v`)], 'v') + close);
    expect((await withServer(up, (url) => send(url, many))).error).toBe('HEADER_TOO_LARGE');
    const twice = Buffer.from(part(['Content-Disposition: form-data; name="a"', 'Content-Disposition: form-data; name="admin"'], 'v') + close);
    expect((await withServer(up, (url) => send(url, twice))).error).toBe('MALFORMED');
  });

  test('la limite totale tient même quand chaque partie reste dans ses limites', async () => {
    const up = createUpload({ limits: { totalSize: 2000, fieldSize: 500, fields: 100 } }).none();
    const body = Buffer.from(Array.from({ length: 10 }, (_, i) => field(`c${i}`, 'v'.repeat(400))).join('') + close);
    expect((await withServer(up, (url) => send(url, body))).error).toBe('LIMIT_TOTAL_SIZE');
  });

  test('des en-têtes qui ne finissent jamais sont refusés avant la fin du corps', async () => {
    const up = createUpload({ limits: { headerSize: 1024 } }).none();
    const body = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="a"; x="${'y'.repeat(5000)}`);
    expect((await withServer(up, (url) => send(url, body, { chunk: 512 }))).error).toBe('HEADER_TOO_LARGE');
  });

  test('un type annoncé mal formé devient text/plain', async () => {
    const up = createUpload().any();
    for (const type of ['pas un type', 'text/html<script>', 'image/png extra', '/png', 'image/']) {
      const res = await withServer(up, (url) => send(url, Buffer.from(file('f', 'a.bin', 'x', type) + close)));
      expect({ type, mimetype: res.files[0].mimetype }).toEqual({ type, mimetype: 'text/plain' });
    }
  });

  test('un corps de 64 Mio pour une limite de 1 Mio : refusé vite, sans garder le corps en mémoire', async () => {
    const up = createUpload({ limits: { totalSize: 1024 * 1024, fileSize: 512 * 1024 } }).single('f');
    await withServer(up, async (url) => {
      const report = await assertBounded(() => new Promise((resolve) => {
        const req = http.request(url, { method: 'POST', headers: { 'content-type': CT } }, (res) => {
          let text = '';
          res.on('data', (d) => { text += d; });
          res.on('end', () => resolve(JSON.parse(text)));
        });
        req.on('error', () => resolve({ error: 'connexion coupée' }));
        req.write(`--${B}\r\nContent-Disposition: form-data; name="f"; filename="a"\r\n\r\n`);
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < 64 * 1024 * 1024) {
            sent += chunk.length;
            if (!req.write(chunk)) return req.once('drain', pump);
          }
          req.end();
        };
        pump();
      }), { maxMs: 10_000, maxHeapGrowthMB: 48 });
      expect(['LIMIT_FILE_SIZE', 'LIMIT_TOTAL_SIZE', 'connexion coupée']).toContain(report.result.error);
    });
  });

  test('un envoi interrompu au milieu : UNEXPECTED_END, jamais une attente sans fin', async () => {
    let outcome;
    const up = createUpload().single('f');
    const server = http.createServer((req, res) => up(req, res, (error) => { outcome = error && error.code; res.end(); }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const req = http.request(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', headers: { 'content-type': CT } });
    req.on('error', () => {});
    req.write(`--${B}\r\nContent-Disposition: form-data; name="f"; filename="a"\r\n\r\nmoitié`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    req.destroy();
    const started = Date.now();
    while (outcome === undefined && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 10));
    server.close();
    expect(outcome).toBe('UNEXPECTED_END');
  });

  test('le fuzz : tout corps donne une réponse ou une UploadError, jamais un plantage ni une attente', async () => {
    const valid = field('a', 'b') + file('f', 'x.txt', 'hello') + close;
    const up = createUpload({ limits: { fileSize: 1000, totalSize: 200_000 } }).any();
    await withServer(up, async (url) => {
      await assertFuzz(async (body) => {
        const out = await send(url, Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'latin1'));
        if (out.error && !/^[A-Z_]+$/.test(out.error)) throw new Error(`unexpected error: ${out.error}`);
        if (out.error) throw Object.assign(new Error(out.error), { status: 400 });
        return out;
      }, { generator: gen.oneOf(gen.mutated([valid, Buffer.from(valid)]), gen.hostileString(), gen.bytes({ max: 2000 })), runs: 400, timeoutMs: 2000 });
    });
  });

  test('aucune expression régulière du lecteur ne s’emballe', async () => {
    for (const regex of extractRegexLiterals(fs.readFileSync(path.join(__dirname, '../src/upload.js'), 'utf8'))) await assertSafeRegex(regex);
  });
});

describe('detectFileType', () => {
  test('reconnaît les formats par leurs premiers octets', () => {
    const cases = [
      [[0xff, 0xd8, 0xff, 0xe0], 'jpg'],
      [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png'],
      [Buffer.from('GIF89a..'), 'gif'],
      [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]), 'webp'],
      [Buffer.from('%PDF-1.7'), 'pdf'],
      [Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif')]), 'avif'],
      [Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]), 'heic'],
      [Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]), 'mp4'],
      [[0x1a, 0x45, 0xdf, 0xa3], 'webm'],
      [Buffer.from('OggS'), 'ogg'],
      [Buffer.from('ID3\u0004'), 'mp3'],
      [[0x50, 0x4b, 0x03, 0x04], 'zip'],
    ];
    for (const [bytes, ext] of cases) expect(detectFileType(Buffer.from(bytes)).ext).toBe(ext);
    expect(detectFileType(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(detectFileType(Buffer.from('ab'))).toBeNull();
    expect(detectFileType('pas un tampon')).toBeNull();
  });

  test('ne plante jamais', async () => {
    const random = createRandom(3);
    for (let i = 0; i < 2000; i++) detectFileType(random.bytes(random.int(0, 40)));
    await assertFuzz((b) => detectFileType(b), { generator: gen.bytes({ max: 64 }), runs: 1000 });
  });
});
