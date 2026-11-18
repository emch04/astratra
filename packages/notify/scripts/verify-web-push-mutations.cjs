'use strict';

/*
 * Les mutations du module Web Push : chaque cas casse une protection, et ses essais doivent échouer.
 * Lancé à la main (npm run verify:mutations dans ce paquet).
 */
const path = require('node:path');
const { runMutations } = require('@astratra/testkit/security');

const file = 'src/webPush.js';
const cases = [
  { name: 'tout hôte accepté', before: '  if (!allowAnyHost) {', after: '  if (false) {' },
  { name: 'http:// accepté', before: "if (url.protocol !== 'https:') throw invalid('subscription endpoint must use https://');", after: '' },
  { name: 'identifiants dans l’adresse acceptés', before: "if (url.username || url.password) throw invalid('subscription endpoint must not contain credentials');", after: '' },
  { name: 'message sans limite de taille', before: '  if (plaintext.length > MAX_PAYLOAD) throw', after: '  if (false) throw' },
  { name: 'point hors de la courbe accepté', before: "    crypto.ECDH.convertKey(bytes, 'prime256v1', undefined, undefined, 'uncompressed');", after: '' },
  { name: 'clés VAPID qui ne vont pas ensemble', before: "if (!ecdh.getPublicKey().equals(publicBytes)) throw invalid('VAPID public key does not match the private key');", after: '' },
  { name: 'réponse lue sans limite', before: '          if (size >= MAX_RESPONSE) {', after: '          if (false) {' },
  { name: 'aucun délai', before: '    }, request.timeoutMs);', after: '    }, 600_000);' },
  { name: 'en-tête géré remplaçable', before: '    if (MANAGED_HEADERS.has(name.toLowerCase())) throw', after: '    if (false) throw' },
  { name: 'retour à la ligne dans un en-tête', before: '    if (text.length > 1024 || /[\\0\\r\\n]/.test(text)) throw', after: '    if (text.length > 1024) throw' },
  { name: 'échéance VAPID à plus de 24 h', before: "    if (expiration > seconds + MAX_EXPIRATION_SECONDS) throw invalid('VAPID expiration must be at most 24 hours ahead');", after: '' },
  { name: 'délimiteur final non vérifié', before: "  if (end === 0 || plain[end - 1] !== 2) throw new WebPushError('body has no final record delimiter', { code: 'decrypt_failed' });", after: '' },
  { name: 'plusieurs enregistrements acceptés', before: '  if (recordSize < 18 || sealed.length > recordSize) throw', after: '  if (false) throw' },
  { name: 'TTL non entier accepté', before: '  if (!Number.isSafeInteger(ttl) || ttl < 0) throw', after: '  if (ttl < 0) throw' },
  { name: 'sel fixe', before: '    salt = crypto.randomBytes(16);', after: '    salt = Buffer.alloc(16);' },
  { name: 'en-tête VAPID jamais refait', before: '    if (!entry || entry.expiration - seconds < 3600) {', after: '    if (!entry) {' },
].map((c) => ({ ...c, file }));

const report = runMutations({
  cwd: path.resolve(__dirname, '..'),
  cases,
  command: ['npx', ['jest', '__tests__/webPush.test.js', '--testTimeout=30000']],
  onResult: (r) => process.stdout.write(`${r.killed ? 'tuée    ' : 'SURVIT  '} ${r.name}\n`),
});
if (!report.allKilled) {
  process.stderr.write(`${report.survivors.length} mutation(s) ont survécu.\n`);
  process.exit(1);
}
process.stdout.write(`${report.results.length} mutations, toutes tuées.\n`);
