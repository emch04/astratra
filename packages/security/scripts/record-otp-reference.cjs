/*
 * Enregistre les réponses d'otplib (générer, vérifier, adresse otpauth) une fois, pour comparer le module TOTP du
 * paquet (__tests__/fixtures/otp-reference.json). otplib n'est pas une dépendance d'Astratra : le chemin d'un projet
 * qui l'installe est donné en argument.
 *   node scripts/record-otp-reference.cjs /chemin/vers/node_modules/otplib
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

(async () => {

const dir = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const otp = await import(pathToFileURL(path.join(dir, 'dist', 'index.js')).href);
const seed = crypto.createHash('sha256');
const rand = (n) => { seed.update(String(n)); return seed.copy().digest(); };
const base32 = (buf) => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); let out = ''; for (let i = 0; i < bits.length; i += 5) out += a[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };

const secrets = Array.from({ length: 12 }, (_, i) => base32(rand(i).subarray(0, 20)));
const epochs = [0, 59, 1111111109, 1234567890, 1800000000, 1800000029, 1800000030, 1795027830];
const generateCases = [];
for (const secret of secrets) for (const epoch of epochs) generateCases.push({ secret, epoch, token: await otp.generate({ secret, epoch }) });
const verifyCases = [];
for (const secret of secrets.slice(0, 6)) {
  const epoch = 1800000015;
  for (const offset of [-120, -61, -45, -31, -30, -15, 0, 14, 15, 29, 30, 31, 45, 60, 61, 90]) {
    const token = await otp.generate({ secret, epoch: epoch + offset });
    for (const epochTolerance of [0, 30, 60]) {
      const r = await otp.verify({ secret, token, epoch, epochTolerance });
      verifyCases.push({ secret, token, epoch, epochTolerance, offset, expected: { valid: r.valid, delta: r.valid ? r.delta : undefined } });
    }
  }
  for (const token of ['000000', '12345', '1234567', 'abcdef', '', ' 123456']) {
    let r;
    try { r = await otp.verify({ secret, token, epoch, epochTolerance: 30 }); r = { valid: r.valid }; } catch (_error) { r = { error: true }; }
    verifyCases.push({ secret, token, epoch, epochTolerance: 30, expected: r });
  }
}
const uriCases = [];
for (const [issuer, label] of [['Épreuves Exemple', 'a@b.test'], ['Mon App', 'élise@example.test'], ['A:B', 'x y'], ['issuer', 'label/with/slash']]) {
  uriCases.push({ issuer, label, secret: secrets[0], uri: otp.generateURI({ issuer, label, secret: secrets[0] }) });
}
const generated = otp.generateSecret();
const out = { source: `otplib ${pkg.version}, recorded for comparison`, generatedSecretLength: generated.length, generatedSecretAlphabet: /^[A-Z2-7]+$/.test(generated), generateCases, verifyCases, uriCases };
fs.writeFileSync(path.join(__dirname, '..', '__tests__', 'fixtures', 'otp-reference.json'), JSON.stringify(out, null, 1) + '\n');
console.log(generateCases.length, 'codes,', verifyCases.length, 'vérifications,', uriCases.length, 'adresses (', out.source, ')');
})();
