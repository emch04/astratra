'use strict';

/*
 * Les mutations du jeton de compte de service Google : chaque cas casse un endroit qui protège, et les essais doivent
 * échouer. Lancé à la main (npm run verify:mutations dans ce paquet) : il modifie la source le temps de chaque essai.
 */
const path = require('node:path');
const { runMutations } = require('@astratra/testkit/security');

const file = 'src/googleServiceAccount.js';
const cases = [
  { name: 'toute adresse d’échange acceptée', file, before: "return url.protocol === 'https:' && !url.username", after: "return true || url.protocol === 'https:' && !url.username" },
  { name: 'http accepté pour l’échange', file, before: "url.protocol === 'https:' && !url.username", after: "(url.protocol === 'https:' || url.protocol === 'http:') && !url.username" },
  { name: 'sous-domaine trompeur accepté', file, before: "url.hostname.endsWith('.googleapis.com')", after: "url.hostname.includes('googleapis.com')" },
  { name: 'clé non RSA acceptée', file, before: "if (privateKey.asymmetricKeyType !== 'rsa') {", after: 'if (false) {' },
  { name: 'jeton jamais gardé', file, before: 'if (!forceRefresh && cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.token;', after: '' },
  { name: 'échanges simultanés non partagés', file, before: 'if (!pending) pending = exchange()', after: 'pending = exchange()' },
  { name: 'pas de nouvel essai après un 401', file, before: 'if (response.status === 401) response = await call(await getAccessToken({ forceRefresh: true }));', after: '' },
  { name: 'réponse d’erreur OAuth recopiée en entier', file, before: "/^[\\w.-]{1,64}$/.test(body.error)", after: 'true' },
  { name: 'pas de délai sur les appels à Google', file, before: 'signal: init.signal || AbortSignal.timeout(timeoutMs)', after: 'signal: init.signal' },
  { name: 'durée annoncée non plafonnée', file, before: 'Math.min(lifetime, ASSERTION_LIFETIME_SECONDS)', after: 'lifetime' },
];

const report = runMutations({
  cwd: path.resolve(__dirname, '..'),
  cases,
  command: ['npx', ['jest', '__tests__/googleServiceAccount.test.js', '--testTimeout=5000']],
  onResult: (r) => process.stdout.write(`${r.killed ? 'tuée    ' : 'SURVIT  '} ${r.name}\n`),
});
if (!report.allKilled) {
  process.stderr.write(`${report.survivors.length} mutation(s) ont survécu.\n`);
  process.exit(1);
}
process.stdout.write(`${report.results.length} mutations, toutes tuées.\n`);
