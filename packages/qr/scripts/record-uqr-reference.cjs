'use strict';

/*
 * Enregistre les matrices d'uqr (adaptation du générateur de référence de Nayuki) une fois, pour comparer le
 * générateur du paquet module par module (__tests__/fixtures/uqr-reference.json). uqr n'est pas une dépendance
 * d'Astratra : le chemin d'un projet qui l'installe est donné en argument.
 *   node scripts/record-uqr-reference.cjs /chemin/vers/node_modules/uqr
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const dir = process.argv[2];
  const { encode } = await import(pathToFileURL(path.join(dir, 'dist', 'index.mjs')).href);
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const pack = (data) => {
    const bits = data.flat();
    const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 0x80 >> (i & 7); });
    return bytes.toString('base64');
  };
  const texts = [
    '', 'x', 'HELLO WORLD', '0', '01234567', '9'.repeat(41), 'A'.repeat(25), 'https://www.example.test/liens',
    'Élève à l’école 🇫🇷', 'otpauth://totp/App:a%40b.test?secret=JBSWY3DPEHPK3PXP&issuer=App', 'WIFI:S:Réseau;T:WPA;P:mot de passe;;',
    'a'.repeat(100), 'a'.repeat(500), '9'.repeat(1000), 'B'.repeat(900), 'é'.repeat(300), 'x'.repeat(2000), '7'.repeat(5000),
  ];
  const cases = [];
  for (const text of texts) {
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      for (const boostEcc of [false, true]) {
        let qr;
        try {
          qr = encode(text, { ecc, boostEcc, border: 0 });
        } catch (error) {
          cases.push({ text, ecc, boostEcc, error: error.message });
          continue;
        }
        cases.push({ text, ecc, boostEcc, version: qr.version, mask: qr.maskPattern, size: qr.size, matrix: pack(qr.data) });
      }
    }
  }
  for (const maskPattern of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const qr = encode('masque forcé 123', { ecc: 'M', maskPattern, border: 0 });
    cases.push({ text: 'masque forcé 123', ecc: 'M', boostEcc: false, forcedMask: maskPattern, version: qr.version, mask: qr.maskPattern, size: qr.size, matrix: pack(qr.data) });
  }
  for (const minVersion of [5, 20, 40]) {
    const qr = encode('version minimale', { ecc: 'Q', minVersion, border: 0 });
    cases.push({ text: 'version minimale', ecc: 'Q', boostEcc: false, minVersion, version: qr.version, mask: qr.maskPattern, size: qr.size, matrix: pack(qr.data) });
  }
  fs.writeFileSync(path.join(__dirname, '..', '__tests__', 'fixtures', 'uqr-reference.json'), JSON.stringify({ source: `uqr ${version} (Nayuki), recorded for comparison`, cases }) + '\n');
  console.log(cases.length, 'cas enregistrés, dont', cases.filter((c) => c.error).length, 'refus ; versions', [...new Set(cases.map((c) => c.version).filter(Boolean))].sort((a, b) => a - b).join(' '));
})();
