'use strict';

/*
 * Les mutations du générateur : chaque cas casse un endroit de la norme ou une protection, et les essais doivent
 * échouer. Lancé à la main (npm run verify:mutations dans ce paquet).
 */
const path = require('node:path');
const { runMutations } = require('@astratra/testkit/security');

const cases = [
  { name: 'Reed-Solomon faux', file: 'src/qr.js', before: 'z = (z << 1) ^ ((z >>> 7) * 0x11d);', after: 'z = (z << 1) ^ ((z >>> 7) * 0x11b);' },
  { name: 'format non masqué', file: 'src/qr.js', before: 'const bits = ((data << 10) | rem) ^ 0x5412;', after: 'const bits = (data << 10) | rem;' },
  { name: 'masque mal choisi (pénalité N3 ignorée)', file: 'src/qr.js', before: 'if (!runColor) result += countPatterns(history) * PENALTY_N3;', after: '' },
  { name: 'masque 5 faux', file: 'src/qr.js', before: 'case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;', after: 'case 5: invert = ((x * y) % 2) === 0; break;' },
  { name: 'pas de remplissage 0xEC 0x11', file: 'src/qr.js', before: 'for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);', after: 'for (; bits.length < capacity; ) append(0, 8);' },
  { name: 'version 7+ sans bits de version', file: 'src/qr.js', before: 'if (version >= 7) {\n    let rem = version;', after: 'if (version >= 99) {\n    let rem = version;' },
  { name: 'mode alphanumérique faux', file: 'src/qr.js', before: "ALPHANUMERIC_CHARSET.indexOf(text[i]) * 45 + ALPHANUMERIC_CHARSET.indexOf(text[i + 1]), 11", after: "ALPHANUMERIC_CHARSET.indexOf(text[i]) * 44 + ALPHANUMERIC_CHARSET.indexOf(text[i + 1]), 11" },
  { name: 'couleur SVG non vérifiée', file: 'src/render.js', before: "if (color !== null && color !== 'transparent' && !SAFE_SVG_COLOR.test(String(color))) throw new QrError(`${name} is not a color`);", after: '' },
  { name: 'titre SVG non échappé', file: 'src/render.js', before: "const label = title ? `<title>${escape(title)}</title>` : '';", after: "const label = title ? `<title>${title}</title>` : '';" },
  { name: 'texte immense accepté', file: 'src/qr.js', before: "if (text.length > MAX_INPUT_BYTES * 2) throw new QrError('data too long for a QR code');", after: '' },
];

const report = runMutations({
  cwd: path.resolve(__dirname, '..'),
  cases,
  command: ['npx', ['jest', '--testTimeout=120000']],
  onResult: (r) => process.stdout.write(`${r.killed ? 'tuée    ' : 'SURVIT  '} ${r.name}\n`),
});
if (!report.allKilled) {
  process.stderr.write(`${report.survivors.length} mutation(s) ont survécu.\n`);
  process.exit(1);
}
process.stdout.write(`${report.results.length} mutations, toutes tuées.\n`);
