'use strict';

/*
 * Les mutations de la double authentification : chaque cas casse une protection, et ses essais doivent échouer.
 * Lancé à la main avec npm run verify:mutations.
 */
const path = require('node:path');
const { runMutations } = require('@astratra/testkit/security');

const file = 'src/totp.js';
const cases = [
  { name: 'code rejoué accepté', before: "if (afterStep !== undefined && afterStep !== null && matched <= afterStep) return { valid: false, reason: 'replay', timeStep: matched };", after: '' },
  { name: 'fenêtre élargie', before: 'const last = Math.floor((epoch + epochTolerance) / period);', after: 'const last = Math.floor((epoch + epochTolerance) / period) + 1;' },
  { name: 'format du code non vérifié', before: "if (typeof token !== 'string' || token.length !== digits || !/^\\d+$/.test(token)) return { valid: false, reason: 'format' };", after: "if (typeof token !== 'string') return { valid: false, reason: 'format' };" },
  { name: 'secret trop court accepté', before: "if (key.length < 10) throw new TotpError('secret must be at least 80 bits (RFC 4226)');", after: '' },
  { name: 'troncature dynamique fausse', before: 'const offset = mac[mac.length - 1] & 0x0f;', after: 'const offset = 0;' },
  { name: 'base32 invalide accepté', before: "if (index < 0) throw new TotpError('secret is not valid base32');", after: 'if (index < 0) continue;' },
  { name: '« : » accepté dans l’émetteur', before: "if (value.includes(':')) throw new TotpError", after: 'if (false) throw new TotpError' },
  { name: 'arrêt au premier pas trouvé', before: 'if (crypto.timingSafeEqual(expected, given) && matched === null) matched = step;', after: 'if (crypto.timingSafeEqual(expected, given)) { matched = step; break; }' },
].map((c) => ({ ...c, file }));

const report = runMutations({
  cwd: path.resolve(__dirname, '..'),
  cases,
  command: ['npx', ['jest', '__tests__/totp.test.js', '--testTimeout=30000']],
  onResult: (r) => process.stdout.write(`${r.killed ? 'tuée    ' : 'SURVIT  '} ${r.name}\n`),
});
if (!report.allKilled) {
  process.stderr.write(`${report.survivors.length} mutation(s) ont survécu.\n`);
  process.exit(1);
}
process.stdout.write(`${report.results.length} mutations, toutes tuées.\n`);
