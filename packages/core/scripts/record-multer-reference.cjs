/* global fetch */
'use strict';

/*
 * Enregistre les réponses de multer 2.4.0 (en mémoire) sur un corpus de formulaires, une fois, pour comparer le lecteur
 * de téléversements de core (__tests__/fixtures/multer-reference.json). multer n'est pas une dépendance d'Astratra :
 * le chemin d'un projet qui l'a installé est donné en argument.
 *   node scripts/record-multer-reference.cjs /chemin/vers/node_modules/multer
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const multer = require(process.argv[2]);
const { gen, createRandom } = require('@astratra/testkit/security');

const random = createRandom('multer-reference');
const B = 'XyZBoundary7MA4YWxkTrZu0gW';
const CT = `multipart/form-data; boundary=${B}`;
const part = (headers, content) => `--${B}\r\n${headers.join('\r\n')}\r\n\r\n${content}\r\n`;
const field = (name, value) => part([`Content-Disposition: form-data; name="${name}"`], value);
const file = (name, filename, content, type = 'application/octet-stream') => part([`Content-Disposition: form-data; name="${name}"; filename="${filename}"`, `Content-Type: ${type}`], content);
const close = `--${B}--\r\n`;

const LIMITS = { fileSize: 64, files: 3, fields: 5, fieldSize: 32, fieldNameSize: 20, parts: 8 };
const cases = [];
const add = (id, mode, body, extra = {}) => cases.push({ id, mode, contentType: extra.contentType || CT, body: Buffer.from(body, extra.encoding || 'utf8').toString('base64'), limits: { ...LIMITS, ...(extra.limits || {}) } });

add('un fichier et deux champs', ['single', 'f'], field('a', 'un') + field('b', 'deux') + file('f', 'x.txt', 'bonjour') + close);
add('champ répété', ['single', 'f'], field('t', '1') + field('t', '2') + field('t', '3') + close);
add('fichier vide', ['single', 'f'], file('f', 'vide.txt', '') + close);
add('fichier exactement à la limite', ['single', 'f'], file('f', 'a.bin', 'x'.repeat(64)) + close);
add('fichier un octet de trop', ['single', 'f'], file('f', 'a.bin', 'x'.repeat(65)) + close);
add('champ exactement à la limite', ['none'], field('a', 'y'.repeat(32)) + close);
add('champ un octet de trop', ['none'], field('a', 'y'.repeat(33)) + close);
add('trop de champs', ['none'], [1, 2, 3, 4, 5, 6].map((i) => field(`c${i}`, 'v')).join('') + close);
add('trop de fichiers (any)', ['any'], [1, 2, 3, 4].map((i) => file(`f${i}`, `${i}.txt`, 'z')).join('') + close);
add('trop de parties', ['any'], [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => field(`p${i}`, 'v')).join('') + close, { limits: { fields: 100 } });
add('nom de champ trop long', ['none'], field('n'.repeat(21), 'v') + close);
add('fichier inattendu (single)', ['single', 'f'], file('autre', 'a.txt', 'x') + close);
add('deux fichiers pour single', ['single', 'f'], file('f', 'a.txt', 'x') + file('f', 'b.txt', 'y') + close);
add('array dans sa limite', ['array', 'f', 2], file('f', 'a.txt', 'x') + file('f', 'b.txt', 'y') + close);
add('array au-delà', ['array', 'f', 2], file('f', 'a.txt', 'x') + file('f', 'b.txt', 'y') + file('f', 'c.txt', 'z') + close);
add('fields', ['fields', [{ name: 'a', maxCount: 1 }, { name: 'b', maxCount: 2 }]], file('a', 'a.txt', 'x') + file('b', 'b1.txt', 'y') + file('b', 'b2.txt', 'z') + field('note', 'ok') + close);
add('none avec un fichier', ['none'], file('f', 'a.txt', 'x') + close);
add('chemin dans le nom', ['single', 'f'], file('f', '../../etc/passwd', 'x') + close);
add('nom sans fichier (filename vide)', ['single', 'f'], file('f', '', 'x') + close);
add('type annoncé', ['single', 'f'], file('f', 'p.png', 'x', 'image/png') + close);
add('type avec paramètre', ['single', 'f'], file('f', 'p.txt', 'x', 'text/plain; charset=utf-8') + close);
add('sans Content-Type de partie', ['single', 'f'], part([`Content-Disposition: form-data; name="f"; filename="n.txt"`], 'abc') + close);
add('préambule et épilogue', ['none'], `ceci est un préambule\r\n` + field('a', 'b') + close + 'épilogue ignoré');
add('frontière entre guillemets', ['none'], field('a', 'b') + close, { contentType: `multipart/form-data; boundary="${B}"` });
add('remplissage après la frontière', ['none'], `--${B}   \r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n` + close);
add('contenu qui ressemble à la frontière', ['single', 'f'], file('f', 'a.txt', `--${B}X pas une frontière`) + close);
add('fin manquante', ['none'], field('a', 'b'));
add('frontière finale sans CRLF', ['none'], field('a', 'b') + `--${B}--`);
add('corps vide', ['none'], '');
add('n’importe quoi', ['none'], 'ceci n’est pas un formulaire');
add('partie sans nom', ['none'], part(['Content-Disposition: form-data'], 'x') + close);
add('partie sans Content-Disposition', ['none'], part(['Content-Type: text/plain'], 'x') + close);
add('en-tête sans deux-points', ['none'], part(['Content-Disposition: form-data; name="a"', 'Pas-un-entete'], 'x') + close);
add('filename* UTF-8', ['single', 'f'], part([`Content-Disposition: form-data; name="f"; filename*=UTF-8''%C3%A9t%C3%A9.txt`], 'x') + close);
add('nom de champ accentué', ['none'], field('élève', 'oui') + close);
add('valeur accentuée', ['none'], field('a', 'Élève à l’école') + close);
add('contenu binaire', ['single', 'f'], file('f', 'b.bin', '\u0000\u0001ÿ\r\n\r\n--') + close);
add('Content-Type sans frontière', ['none'], field('a', 'b') + close, { contentType: 'multipart/form-data' });
add('pas du multipart', ['none'], 'a=b', { contentType: 'application/x-www-form-urlencoded' });
add('__proto__ en nom de champ', ['none'], field('__proto__', 'x') + close);
add('constructor en nom de champ', ['none'], field('constructor', 'x') + close);
for (let i = 0; i < 150; i++) {
  const base = field('a', 'b') + file('f', 'x.txt', 'hello') + close;
  add(`muté ${i}`, ['single', 'f'], gen.mutated([base]).generate(random.fork(`m${i}`)));
}

async function run(c) {
  const upload = multer({ storage: multer.memoryStorage(), limits: c.limits });
  const [mode, ...args] = c.mode;
  const handler = upload[mode](...args);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res, (error) => {
      const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : req.files ? Object.values(req.files).flat() : [];
      const out = error ? { error: error.code || error.message } : {
        body: req.body && Object.fromEntries(Object.entries(req.body)),
        files: files.map((f) => ({ fieldname: f.fieldname, originalname: f.originalname, encoding: f.encoding, mimetype: f.mimetype, size: f.size, sha256: crypto.createHash('sha256').update(f.buffer).digest('hex') })),
      };
      res.end(JSON.stringify(out));
    }));
    server.listen(0, async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', headers: { 'content-type': c.contentType }, body: Buffer.from(c.body, 'base64') });
        resolve(JSON.parse(await response.text()));
      } catch (error) {
        resolve({ error: `CLIENT ${error.message}` });
      } finally {
        server.close();
      }
    });
  });
}

(async () => {
  for (const c of cases) c.expected = await run(c);
  const out = { source: `multer ${require(path.join(process.argv[2], 'package.json')).version} (memoryStorage), recorded for comparison`, boundary: B, cases };
  fs.writeFileSync(path.join(__dirname, '..', '__tests__', 'fixtures', 'multer-reference.json'), JSON.stringify(out) + '\n');
  const summary = {};
  for (const c of cases) { const k = c.expected.error ? `erreur ${c.expected.error}` : 'accepté'; summary[k] = (summary[k] || 0) + 1; }
  console.log(cases.length, 'cas', summary);
})();
