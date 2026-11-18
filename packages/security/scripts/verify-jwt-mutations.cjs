'use strict';

/*
 * Les mutations du module de jetons : chaque cas casse un endroit qui protège (algorithme, signature, échéance,
 * audience, clé…) et lance les essais. Chaque mutation doit être tuée. Lancé à la main (npm run verify:mutations).
 */
const path = require('node:path');
const { runMutations } = require('@astratra/testkit/security');

const file = 'src/jwt.js';
const cases = [
  { name: 'algorithme hors de la liste accepté', before: "if (typeof header.alg !== 'string' || !algorithms.includes(header.alg))", after: "if (typeof header.alg !== 'string')" },
  { name: 'signature HMAC jamais comparée', before: 'return signature.length === expected.length && crypto.timingSafeEqual(signature, expected);', after: 'return true;' },
  { name: 'clé publique acceptée comme secret HMAC', before: "if (typeof key === 'string' && looksLikePem(key)) throw new JsonWebTokenError(`secretOrPublicKey must be a symmetric key when using ${alg}`);", after: '' },
  { name: 'échéance ignorée', before: "if (now >= payload.exp + tolerance) throw new TokenExpiredError('jwt expired', new Date(payload.exp * 1000));", after: '' },
  { name: '« pas avant » ignoré', before: "if (payload.nbf > now + tolerance) throw new NotBeforeError('jwt not active', new Date(payload.nbf * 1000));", after: '' },
  { name: 'audience ignorée', before: 'if (!match) throw new JsonWebTokenError(`jwt audience invalid.', after: 'if (false) throw new JsonWebTokenError(`jwt audience invalid.' },
  { name: 'émetteur ignoré', before: "if (typeof payload.iss !== 'string' || !wanted.includes(payload.iss)) throw", after: 'if (false) throw' },
  { name: 'base64url non canonique accepté', before: "return bytes.toString('base64url') === segment ? bytes : null;", after: 'return bytes;' },
  { name: 'courbe EC non vérifiée', before: 'keyObject.asymmetricKeyDetails.namedCurve !== EC_CURVE[alg]', after: 'false' },
  { name: 'clé RSA courte acceptée', before: 'keyObject.asymmetricKeyDetails.modulusLength < 2048', after: 'keyObject.asymmetricKeyDetails.modulusLength < 1024' },
  { name: 'en-tête crit accepté', before: "if (header.crit !== undefined) throw new JsonWebTokenError('unsupported critical header');", after: '' },
  { name: 'charge non objet acceptée', before: "  const payload = parseJsonSegment(parts[1]);\n  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new JsonWebTokenError('invalid token');", after: '  const payload = parseJsonSegment(parts[1]);' },
  { name: 'jeton immense accepté', before: 'if (token.length > (options.maxTokenLength || DEFAULT_MAX_TOKEN_LENGTH))', after: 'if (false)' },
].map((c) => ({ ...c, file }));

const report = runMutations({
  cwd: path.resolve(__dirname, '..'),
  cases,
  command: ['npx', ['jest', '__tests__/jwt.test.js', '__tests__/jwtAuth.test.js', '__tests__/idTokens.test.js', '__tests__/securityKit.test.js', '--testTimeout=20000']],
  onResult: (r) => process.stdout.write(`${r.killed ? 'tuée    ' : 'SURVIT  '} ${r.name}\n`),
});
if (!report.allKilled) {
  process.stderr.write(`${report.survivors.length} mutation(s) ont survécu.\n`);
  process.exit(1);
}
process.stdout.write(`${report.results.length} mutations, toutes tuées.\n`);
