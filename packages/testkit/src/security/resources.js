'use strict';

const { AssertionError } = require('node:assert');
const zlib = require('node:zlib');

/**
 * Les entrées qui épuisent les ressources : petites à envoyer, énormes une fois lues. Une cible sûre les refuse vite et
 * sans garder en mémoire ce qu'elle ne devait pas lire.
 */
const bombs = {
  /** `[[[[…]]]]` : un analyseur récursif dépasse sa pile. */
  deepJsonArray: (depth = 100_000) => '['.repeat(depth) + ']'.repeat(depth),
  /** `{"a":{"a":…}}`. */
  deepJsonObject: (depth = 100_000) => '{"a":'.repeat(depth) + 'null' + '}'.repeat(depth),
  /** Un objet aux très nombreuses clés (tables de hachage, validation clé par clé). */
  wideJsonObject: (keys = 200_000) => `{${Array.from({ length: keys }, (_, i) => `"k${i}":0`).join(',')}}`,
  /** Un tableau immense de petites valeurs. */
  wideJsonArray: (items = 1_000_000) => `[${'0,'.repeat(items - 1)}0]`,
  /** Une seule chaîne immense. */
  hugeString: (bytes = 16 * 1024 * 1024, char = 'a') => char.repeat(bytes),
  /** Une ligne sans fin (lecteur ligne à ligne). */
  endlessLine: (bytes = 16 * 1024 * 1024) => 'x'.repeat(bytes),
  /** Des données gzip d'environ un millième de leur taille, qui font `bytes` une fois décompressées. */
  gzip: (bytes = 256 * 1024 * 1024) => compressRepeated(bytes, zlib.gzipSync),
  /** Pareil, en deflate brut (Content-Encoding: deflate mal annoncé, archives). */
  deflateRaw: (bytes = 256 * 1024 * 1024) => compressRepeated(bytes, zlib.deflateRawSync),
  /** Brotli. */
  brotli: (bytes = 256 * 1024 * 1024) => compressRepeated(bytes, zlib.brotliCompressSync),
  /** Un gzip dans un gzip : celui qui décompresse « tant que c'est du gzip » ouvre la seconde couche. */
  nestedGzip: (bytes = 256 * 1024 * 1024) => zlib.gzipSync(compressRepeated(bytes, zlib.gzipSync)),
  /** Beaucoup d'en-têtes ou d'en-têtes immenses. */
  manyHeaders: (count = 10_000) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`x-h${i}`, 'v'])),
  hugeHeader: (bytes = 1024 * 1024) => ({ 'x-huge': 'v'.repeat(bytes) }),
  /** Une requête de formulaire aux paramètres répétés (`a=1&a=1&…`). */
  repeatedQuery: (count = 100_000, key = 'a') => Array.from({ length: count }, () => `${key}=1`).join('&'),
  /** Des « a[b][c][d]… » imbriqués (analyseurs de formulaires étendus). */
  deepQuery: (depth = 10_000) => `a${'[b]'.repeat(depth)}=1`,
};

function compressRepeated(bytes, compress) {
  const chunk = Buffer.alloc(Math.min(bytes, 1024 * 1024));
  const parts = [];
  // Compresser 256 Mo de zéros d'un coup demanderait 256 Mo de mémoire : on compresse un mégaoctet et on enchaîne
  // les membres gzip (valide en gzip) ; pour deflate et brotli, un seul membre d'au plus 64 Mo suffit à l'attaque.
  if (compress === zlib.gzipSync) {
    const member = compress(chunk);
    for (let left = bytes; left > 0; left -= chunk.length) parts.push(member);
    return Buffer.concat(parts);
  }
  return compress(Buffer.alloc(Math.min(bytes, 64 * 1024 * 1024)));
}

/**
 * Lance `run` et vérifie qu'il refuse ou répond dans les limites : `maxMs` de durée et `maxHeapGrowthMB` de mémoire en
 * plus (mesurée avant et après, et au plus haut pendant l'appel par un relevé régulier). Une erreur levée est une
 * réponse (un refus) ; seule une durée ou une mémoire hors limites fait échouer.
 */
async function checkBounded(run, { maxMs = 1_000, maxHeapGrowthMB = 64, sampleEveryMs = 5 } = {}) {
  if (typeof run !== 'function') throw new TypeError('checkBounded needs a function.');
  global.gc?.();
  const before = process.memoryUsage();
  let peak = before.heapUsed + before.arrayBuffers;
  const sampler = setInterval(() => {
    const now = process.memoryUsage();
    peak = Math.max(peak, now.heapUsed + now.arrayBuffers);
  }, sampleEveryMs);
  sampler.unref?.();
  const started = process.hrtime.bigint();
  let outcome;
  try {
    outcome = { result: await run() };
  } catch (error) {
    outcome = { error };
  } finally {
    clearInterval(sampler);
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const after = process.memoryUsage();
  peak = Math.max(peak, after.heapUsed + after.arrayBuffers);
  const growthMB = (peak - (before.heapUsed + before.arrayBuffers)) / (1024 * 1024);
  const problems = [];
  if (ms > maxMs) problems.push(`took ${ms.toFixed(0)} ms (limit ${maxMs} ms)`);
  if (growthMB > maxHeapGrowthMB) problems.push(`memory grew by ${growthMB.toFixed(1)} MB (limit ${maxHeapGrowthMB} MB)`);
  return { bounded: problems.length === 0, ms, growthMB, refused: Boolean(outcome.error), error: outcome.error, result: outcome.result, problems };
}

async function assertBounded(run, options = {}) {
  const report = await checkBounded(run, options);
  if (!report.bounded) throw new AssertionError({ message: `${options.name ? `${options.name}: ` : ''}${report.problems.join('; ')}.` });
  return report;
}

module.exports = { bombs, checkBounded, assertBounded };
