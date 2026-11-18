'use strict';

/*
 * Les mutations du limiteur : chaque cas casse volontairement un endroit qui protège (la limite, la panne du magasin,
 * le bloc IPv6, la fenêtre, le hachage des clés…) et lance ses essais. Chaque mutation doit être tuée. Lancé à la main
 * (npm run verify:mutations dans ce paquet), pas avec npm test : il modifie les sources le temps de chaque essai.
 */
const path = require('node:path');
const { runMutations } = require('@astratra/testkit/security');

const cases = [
  { name: 'la limite n’est jamais atteinte', file: 'src/rateLimit.js', before: 'if (totalHits > limit) {', after: 'if (false) {' },
  { name: 'un magasin en panne laisse passer', file: 'src/rateLimit.js', before: 'if (options.passOnStoreError) return next();', after: 'return next();' },
  { name: 'chaque adresse IPv6 a son compteur', file: 'src/rateLimit.js', before: 'if (!subnet) return formatIpv6(groups);', after: 'return formatIpv6(groups);' },
  { name: 'la fenêtre ne se termine jamais', file: 'src/rateLimit.js', before: 'if (!counter || counter.resetAt <= now) {', after: 'if (!counter) {' },
  { name: 'un décompte descend sous zéro', file: 'src/rateLimit.js', before: 'if (counter && counter.hits > 0) counter.hits -= 1;', after: 'if (counter) counter.hits -= 1;' },
  { name: 'Redis en panne laisse tout passer', file: 'src/redisRateLimitStore.js', before: "        logger.warn('Redis ne répond pas", after: "        return { totalHits: 0, resetTime: new Date() }; logger.warn('Redis ne répond pas" },
  { name: 'les clés Redis en clair', file: 'src/redisRateLimitStore.js', before: "(hashKeys ? crypto.createHash('sha256').update(String(key)).digest('hex') : String(key))", after: 'String(key)' },
  { name: 'Redis figé fait attendre sans fin', file: 'src/redisRateLimitStore.js', before: 'const result = await withTimeout(Promise.resolve().then(operation));', after: 'const result = await Promise.resolve().then(operation);' },
];

const report = runMutations({
  cwd: path.resolve(__dirname, '..'),
  cases,
  command: ['npx', ['jest', '__tests__/rateLimit.test.js', '__tests__/rateLimiters.test.js', '--testTimeout=5000']],
  onResult: (r) => process.stdout.write(`${r.killed ? 'tuée    ' : 'SURVIT  '} ${r.name}\n`),
});
if (!report.allKilled) {
  process.stderr.write(`${report.survivors.length} mutation(s) ont survécu.\n`);
  process.exit(1);
}
process.stdout.write(`${report.results.length} mutations, toutes tuées.\n`);
