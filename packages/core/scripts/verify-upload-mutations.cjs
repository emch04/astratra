'use strict';

/*
 * Les mutations du lecteur de téléversements : chaque cas casse une protection, et ses essais doivent échouer.
 * Lancé à la main (npm run verify:mutations dans ce paquet).
 */
const path = require('node:path');
const { runMutations } = require('@astratra/testkit/security');

const file = 'src/upload.js';
const cases = [
  { name: 'taille de fichier non limitée', before: "} else if (part.size > limits.fileSize) {", after: '} else if (false) {' },
  { name: 'taille totale non limitée', before: "if (total > limits.totalSize) return fail(new UploadError('LIMIT_TOTAL_SIZE'));", after: '' },
  { name: '__proto__ accepté', before: "if (FORBIDDEN_NAMES.has(name)) throw new UploadError('FIELD_NAME_FORBIDDEN', name);", after: '' },
  { name: 'en-tête répété accepté', before: "if (headerName.toLowerCase() in headers) throw new UploadError('MALFORMED');", after: '' },
  { name: 'chemin gardé dans le nom', before: 'const baseName = filename.split(/[\\\\/]/).pop();', after: 'const baseName = filename;' },
  { name: 'fichier inattendu accepté', before: "if (!accept(file)) throw new UploadError('LIMIT_UNEXPECTED_FILE', name);", after: '' },
  { name: 'en-têtes sans limite', before: "if (carry.length > limits.headerSize) throw new UploadError('HEADER_TOO_LARGE');", after: '' },
  { name: 'corps interrompu accepté', before: "if (state !== 'done') return fail(new UploadError(state === 'preamble' && total === 0 ? 'MALFORMED' : 'UNEXPECTED_END'));", after: '' },
  { name: 'frontière coupée entre deux morceaux perdue', before: 'const keep = Math.min(carry.length, delimiter.length - 1);', after: 'const keep = 0;' },
  { name: 'trop de champs acceptés', before: "if (fieldCount > limits.fields) throw new UploadError('LIMIT_FIELD_COUNT', name);", after: '' },
  { name: 'type annoncé non vérifié', before: "mimetype: /^[!#$%&'*+\\-.^_`|~0-9a-z]{1,127}\\/[!#$%&'*+\\-.^_`|~0-9a-z]{1,127}$/.test(announced) ? announced : 'text/plain',", after: "mimetype: announced || 'text/plain'," },
].map((c) => ({ ...c, file }));

const report = runMutations({
  cwd: path.resolve(__dirname, '..'),
  cases,
  command: ['npx', ['jest', '__tests__/upload.test.js', '--testTimeout=30000']],
  onResult: (r) => process.stdout.write(`${r.killed ? 'tuée    ' : 'SURVIT  '} ${r.name}\n`),
});
if (!report.allKilled) {
  process.stderr.write(`${report.survivors.length} mutation(s) ont survécu.\n`);
  process.exit(1);
}
process.stdout.write(`${report.results.length} mutations, toutes tuées.\n`);
