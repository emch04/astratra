'use strict';

/*
 * Les mutations du client S3 : chaque cas casse une protection ou une règle de la signature, et ses essais doivent
 * échouer. Lancé à la main (npm run verify:mutations dans ce paquet ; avec S3_TEST_ENDPOINT, le vrai service compte).
 */
const path = require('node:path');
const { runMutations } = require('@astratra/testkit/security');

const cases = [
  ['src/client.js', 'segment « .. » accepté', "if (key.split('/').some((s) => s === '.' || s === '..')) throw", 'if (false) throw'],
  ['src/client.js', 'caractère de contrôle accepté', "  if (CONTROL.test(key)) throw invalid('key must not contain control characters');", ''],
  ['src/client.js', 'nom de compartiment non vérifié', "if (typeof bucket !== 'string' || !BUCKET.test(bucket) ||", 'if (typeof bucket !== "string" || false ||'],
  ['src/client.js', 'http:// vers une autre machine', "if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) throw", 'if (false) throw'],
  ['src/client.js', 'identifiants dans l’adresse', "if (url.username || url.password) throw invalid('endpoint must not contain credentials');", ''],
  ['src/client.js', 'taille annoncée non vérifiée', 'if (ok && Number.isFinite(announced) && announced > limit) {', 'if (false) {'],
  ['src/client.js', 'objet lu sans limite', '            if (size > limit) {', '            if (false) {'],
  ['src/client.js', 'erreur lue sans limite', 'const limit = ok ? maxBytes : MAX_XML;', 'const limit = ok ? maxBytes : Infinity;'],
  ['src/client.js', 'aucun délai', '      }, timeoutMs);', '      }, 3_600_000);'],
  ['src/client.js', 'retour à la ligne dans un en-tête', '  if (!HEADER_VALUE.test(text)) throw', '  if (false) throw'],
  ['src/client.js', 'métadonnées sans limite', "      if (total > 2048) throw invalid('metadata must be at most 2 KB in all (the S3 limit)');", ''],
  ['src/client.js', 'plage non vérifiée', '    const match = typeof range === \'string\' ? RANGE.exec(range) : null;\n    if (', '    const match = typeof range === \'string\' ? RANGE.exec(range) : null;\n    if (false && '],
  ['src/client.js', 'lien de plus de 7 jours', "if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604_800) throw", 'if (!Number.isInteger(expiresIn) || expiresIn < 1) throw'],
  ['src/client.js', 'type d’un dépôt non signé', "      if (contentType !== undefined) headers['content-type'] = checkHeaderValue('contentType', contentType);", ''],
  ['src/client.js', 'clé encodée non décodée', "        return decodeURIComponent(value.replace(/\\+/g, ' '));", '        return value;'],
  ['src/client.js', 'entrée non objet acceptée', "    if (!input || typeof input !== 'object' || Array.isArray(input)) throw", '    if (false) throw'],
  ['src/xml.js', 'DOCTYPE accepté', "    } else if (text[lt + 1] === '!') {", '    } else if (false) {'],
  ['src/xml.js', 'entité inconnue acceptée', '      throw new XmlError(`unknown entity &${name.slice(0, 20)};`);', "      out += '';"],
  ['src/xml.js', 'profondeur sans limite', "        if (stack.length > maxDepth) throw new XmlError('document too deep');", ''],
  ['src/sigv4.js', 'espaces des en-têtes gardés', ".trim().replace(/ {2,}/g, ' ')", '.trim()'],
  ['src/sigv4.js', 'requête non triée', '    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))\n', ''],
  ['src/sigv4.js', 'encodage incomplet', "return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);", 'return encodeURIComponent(value);'],
  ['src/sigv4.js', 'cache-control signé', "'cache-control', ", ''],
].map(([file, name, before, after]) => ({ file, name, before, after }));

const report = runMutations({
  cwd: path.resolve(__dirname, '..'),
  cases,
  command: ['npx', ['jest', '__tests__/s3.test.js', '--testTimeout=20000']],
  onResult: (r) => process.stdout.write(`${r.killed ? 'tuée    ' : 'SURVIT  '} ${r.name}\n`),
});
if (!report.allKilled) {
  process.stderr.write(`${report.survivors.length} mutation(s) ont survécu.\n`);
  process.exit(1);
}
process.stdout.write(`${report.results.length} mutations, toutes tuées.\n`);
