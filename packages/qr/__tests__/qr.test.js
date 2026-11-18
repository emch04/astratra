const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { assertVectors, assertFuzz, assertProperty, gen, payloads, assertSafeRegex, extractRegexLiterals } = require('@astratra/testkit/security');
const { createQr, qrToSvg, qrToPng, qrToDataUrl, QrError } = require('../src');

// Le générateur de codes QR, sans dépendance : comparé module par module à uqr (Nayuki), vérifié sur la structure de
// la norme, relu par un décodeur indépendant quand il est installé, puis essayé sous attaque.

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/uqr-reference.json'), 'utf8'));
const pack = (qr) => {
  const bytes = Buffer.alloc(Math.ceil((qr.size * qr.size) / 8));
  qr.modules.data.forEach((b, i) => { if (b) bytes[i >> 3] |= 0x80 >> (i & 7); });
  return bytes.toString('base64');
};

describe(`comparé à ${reference.source}`, () => {
  test(`mêmes matrices, versions et masques sur ${reference.cases.length} cas (versions 1 à 40, L/M/Q/H, masques forcés)`, async () => {
    await assertVectors(reference.cases.map((c) => ({ id: `${JSON.stringify(c.text.slice(0, 20))}${c.text.length > 20 ? `…(${c.text.length})` : ''} ${c.ecc}${c.boostEcc ? '+' : ''}${c.forcedMask !== undefined ? ` masque ${c.forcedMask}` : ''}${c.minVersion ? ` v≥${c.minVersion}` : ''}`, input: c, expected: c.error ? 'refused' : { version: c.version, mask: c.mask, size: c.size, matrix: c.matrix } })), (c) => {
      try {
        const qr = createQr(c.text, { ecc: c.ecc, boostEcc: c.boostEcc, mask: c.forcedMask, minVersion: c.minVersion });
        return { version: qr.version, mask: qr.mask, size: qr.size, matrix: pack(qr) };
      } catch (error) {
        if (error instanceof QrError) return 'refused';
        throw error;
      }
    }, { source: reference.source });
  });
});

describe('structure de la norme', () => {
  const formatOf = (qr) => {
    // Les 15 bits de format, autour du repère en haut à gauche, puis démasqués et vérifiés par leur code BCH.
    const bits = [];
    for (let i = 0; i <= 5; i++) bits.push(qr.modules.get(i, 8));
    bits.push(qr.modules.get(7, 8), qr.modules.get(8, 8), qr.modules.get(8, 7));
    for (let i = 9; i < 15; i++) bits.push(qr.modules.get(8, 14 - i));
    const value = bits.reduce((v, b, i) => v | ((b ? 1 : 0) << i), 0) ^ 0x5412;
    const data = value >>> 10;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return { valid: ((data << 10) | rem) === value, ecc: { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }[data >>> 3], mask: data & 7 };
  };

  test('repères, lignes de synchronisation, module sombre et format, pour chaque niveau et chaque masque (propriété)', async () => {
    await assertProperty(gen.record({ text: gen.string({ min: 1, max: 120, alphabet: 'ascii' }), ecc: gen.elements(['L', 'M', 'Q', 'H']), mask: gen.integer(0, 7) }), ({ text, ecc, mask }) => {
      const qr = createQr(text, { ecc, mask });
      const n = qr.size;
      const finder = (r, c) => [0, 6].every((d) => qr.modules.get(r + d, c) && qr.modules.get(r, c + d)) && qr.modules.get(r + 3, c + 3) && !qr.modules.get(r + 1, c + 1);
      if (!finder(0, 0) || !finder(0, n - 7) || !finder(n - 7, 0)) return false;
      for (let i = 8; i < n - 8; i++) if (qr.modules.get(6, i) !== (i % 2 === 0) || qr.modules.get(i, 6) !== (i % 2 === 0)) return false;
      if (!qr.modules.get(n - 8, 8)) return false;
      const format = formatOf(qr);
      return format.valid && format.ecc === qr.ecc && format.mask === mask && n === qr.version * 4 + 17;
    }, { runs: 300 });
  });

  test('le plus grand contenu tient en version 40 ; un octet de plus est refusé', () => {
    expect(createQr('9'.repeat(7089), { ecc: 'L' }).version).toBe(40);
    expect(() => createQr('9'.repeat(7090), { ecc: 'L' })).toThrow(QrError);
    expect(createQr('a'.repeat(2953), { ecc: 'L' }).version).toBe(40);
    expect(() => createQr('a'.repeat(2954), { ecc: 'L' })).toThrow(/too long/);
    expect(() => createQr('a', { ecc: 'X' })).toThrow(/ecc/);
    expect(() => createQr('a', { mask: 9 })).toThrow(/mask/);
    expect(() => createQr(42)).toThrow(QrError);
  });
});

/* Le décodeur de qr-scanner (port de jsQR), s'il est installé quelque part : QR_DECODER_WORKER=…/qr-scanner-worker.min.js. */
const decoderPath = process.env.QR_DECODER_WORKER;
const decoderTest = decoderPath && fs.existsSync(decoderPath) ? test : test.skip;
decoderTest('relu par un décodeur indépendant : le texte revient à l’identique', () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const { createRandom } = require('@astratra/testkit/security');
  const random = createRandom(7);
  const texts = ['', 'x', 'HELLO WORLD', '0123456789', 'Élève à l’école 🇫🇷', 'https://www.example.test/a?b=c&d=e', '9'.repeat(1500), 'B'.repeat(800)];
  const generators = [gen.string({ min: 1, max: 200, alphabet: 'ascii' }), gen.string({ min: 1, max: 300, alphabet: '0123456789' }), gen.string({ min: 1, max: 120, alphabet: 'alnum' })];
  for (let i = 0; i < 120; i++) texts.push(random.pick(generators).generate(random.fork(`t${i}`)));
  const cases = texts.flatMap((text, i) => {
    const qr = createQr(text, { ecc: ['L', 'M', 'Q', 'H'][i % 4], mask: i % 3 === 0 ? i % 8 : undefined });
    return [{ text, size: qr.size, data: Buffer.from(qr.modules.data).toString('base64') }];
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qr-')), 'codes.json');
  fs.writeFileSync(file, JSON.stringify(cases.map(({ size, data }) => ({ size, data }))));
  const decoded = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers/decode.cjs'), decoderPath, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const wrong = cases.filter((c, i) => decoded[i] !== c.text).map((c) => c.text.slice(0, 30));
  expect({ decoded: cases.length - wrong.length, wrong }).toEqual({ decoded: cases.length, wrong: [] });
}, 120_000);

describe('rendu', () => {
  const qr = createQr('https://www.example.test/liens', { ecc: 'M' });

  test('SVG : un carré par module sombre, la marge, le titre échappé', () => {
    const svg = qrToSvg(qr, { margin: 2, width: 220, title: 'Lien <secret> & "x"' });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 33 33" width="220" height="220"/);
    expect(svg).toContain('<title>Lien &lt;secret&gt; &amp; &quot;x&quot;</title>');
    const area = [...svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)].reduce((sum, m) => sum + Number(m[3]), 0);
    expect(area).toBe(qr.modules.data.reduce((a, b) => a + b, 0));
    expect(qrToSvg('x', { light: null })).not.toContain('<rect');
  });

  test('SVG : une couleur piégée est refusée (pas d’injection dans l’image)', () => {
    for (const color of ['red"/><script>alert(1)</script>', 'url(javascript:alert(1))', 'expression(alert(1))', '#12345g', '', ...payloads.xss]) {
      expect(() => qrToSvg(qr, { dark: color })).toThrow(QrError);
    }
    for (const color of ['#000', '#1b2a4a', '#1b2a4aff', 'black', 'rgb(10, 20, 30)', 'hsla(10,20%,30%,0.5)']) expect(() => qrToSvg(qr, { dark: color })).not.toThrow();
  });

  test('PNG : signature, dimensions, sommes de contrôle et pixels justes', () => {
    const png = qrToPng(qr, { scale: 3, margin: 4, dark: '#1b2a4a' });
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const chunks = [];
    for (let i = 8; i < png.length; ) {
      const len = png.readUInt32BE(i);
      const type = png.subarray(i + 4, i + 8).toString('latin1');
      const data = png.subarray(i + 8, i + 8 + len);
      expect(png.readUInt32BE(i + 8 + len)).toBe(zlib.crc32(png.subarray(i + 4, i + 8 + len)) >>> 0);
      chunks.push({ type, data });
      i += 12 + len;
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    const side = (qr.size + 8) * 3;
    expect(chunks[0].data.readUInt32BE(0)).toBe(side);
    expect(chunks[1].data).toEqual(Buffer.from([255, 255, 255, 0x1b, 0x2a, 0x4a]));
    const raw = zlib.inflateSync(chunks[2].data);
    const rowBytes = Math.ceil(side / 8);
    const pixel = (px, py) => (raw[py * (rowBytes + 1) + 1 + (px >> 3)] >> (7 - (px & 7))) & 1;
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) expect(pixel((x + 4) * 3 + 1, (y + 4) * 3 + 1)).toBe(qr.modules.get(y, x) ? 1 : 0);
    expect(pixel(0, 0)).toBe(0);
    expect(qrToPng(qr, { light: '#ffffff00' }).includes(Buffer.from('tRNS'))).toBe(true);
    expect(() => qrToPng(qr, { dark: 'black' })).toThrow(/hex color/);
    expect(() => qrToPng(qr, { scale: 1000 })).toThrow(/scale/);
  });

  test('adresse data: en SVG ou en PNG', () => {
    expect(qrToDataUrl('x')).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    expect(qrToDataUrl('x', { type: 'png' })).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(() => qrToDataUrl('x', { type: 'gif' })).toThrow(QrError);
  });
});

describe('attaques', () => {
  test('tout texte donne un code ou une QrError, jamais un plantage', async () => {
    await assertFuzz((text) => {
      try {
        return createQr(text, { ecc: 'H' });
      } catch (error) {
        if (error instanceof QrError) throw Object.assign(error, { status: 400 });
        throw error;
      }
    }, { generator: gen.oneOf(gen.hostileString(), gen.string({ max: 3000, alphabet: 'hostile' }), gen.json()), runs: 300, timeoutMs: 2000 });
  });

  test('un texte immense est refusé avant tout calcul', () => {
    const started = Date.now();
    expect(() => createQr('a'.repeat(10_000_000))).toThrow(/too long/);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test('aucune expression régulière du paquet ne s’emballe', async () => {
    for (const file of ['qr.js', 'render.js']) {
      for (const regex of extractRegexLiterals(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'))) await assertSafeRegex(regex);
    }
  });
});
