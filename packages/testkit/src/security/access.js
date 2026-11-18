'use strict';

const { AssertionError } = require('node:assert');

/**
 * La matrice d'autorisations : chaque acteur × chaque action × chaque ressource, avec la réponse attendue. Une faille
 * d'accès (OWASP A01, BOLA ou IDOR quand un compte lit la fiche d'un autre) ne se voit qu'en essayant toutes les cases,
 * y compris celles qu'aucun écran ne propose.
 *
 *   - `actors` : { nom: contexte } (session, jeton, en-têtes… ce que `attempt` sait utiliser ; `null` pour un anonyme) ;
 *   - `actions` : liste de noms (« lire », « modifier », « supprimer »…) ;
 *   - `resources` : { nom: ressource } (une fiche à soi, celle d'un autre, une route d'administration…) ;
 *   - `expected({ actor, action, resource })` : 'allow' ou 'deny' ;
 *   - `attempt({ actor, context, action, resource, target })` : fait l'essai, rend un booléen, un statut HTTP
 *     ({ status } ou un nombre : 2xx et 3xx autorisent, le reste refuse) ou lève pour refuser.
 */
async function checkAuthorizationMatrix({ actors, actions, resources, expected, attempt }) {
  if (!actors || !actions || !resources || typeof expected !== 'function' || typeof attempt !== 'function') throw new TypeError('checkAuthorizationMatrix needs actors, actions, resources, expected and attempt.');
  const cells = [];
  for (const [actor, context] of Object.entries(actors)) {
    for (const action of actions) {
      for (const [resource, target] of Object.entries(resources)) {
        const want = expected({ actor, action, resource, context, target });
        if (want !== 'allow' && want !== 'deny') throw new Error(`expected() must return "allow" or "deny" (got ${String(want)} for ${actor} / ${action} / ${resource}).`);
        let got;
        let detail;
        try {
          const answer = await attempt({ actor, context, action, resource, target });
          got = allowedFrom(answer) ? 'allow' : 'deny';
          detail = typeof answer === 'object' && answer !== null ? answer.status : answer;
        } catch (error) {
          got = 'deny';
          detail = error && (error.status ?? error.code ?? error.message);
        }
        cells.push({ actor, action, resource, expected: want, actual: got, detail });
      }
    }
  }
  const wrong = cells.filter((c) => c.expected !== c.actual);
  return { passed: wrong.length === 0, cells, wrong, tooOpen: wrong.filter((c) => c.actual === 'allow'), tooClosed: wrong.filter((c) => c.actual === 'deny') };
}

async function assertAuthorizationMatrix(options) {
  const report = await checkAuthorizationMatrix(options);
  if (!report.passed) {
    const line = (c) => `  - ${c.actor} ${c.action} ${c.resource}: expected ${c.expected}, got ${c.actual}${c.detail !== undefined ? ` (${c.detail})` : ''}`;
    const parts = [];
    if (report.tooOpen.length) parts.push(`ALLOWED BUT SHOULD BE DENIED (${report.tooOpen.length}):\n${report.tooOpen.map(line).join('\n')}`);
    if (report.tooClosed.length) parts.push(`denied but should be allowed (${report.tooClosed.length}):\n${report.tooClosed.map(line).join('\n')}`);
    throw new AssertionError({ message: `${options.name ? `${options.name}: ` : ''}authorization matrix: ${report.wrong.length} of ${report.cells.length} cell(s) wrong.\n${parts.join('\n')}` });
  }
  return report;
}

function allowedFrom(answer) {
  if (typeof answer === 'boolean') return answer;
  const status = typeof answer === 'number' ? answer : answer && typeof answer === 'object' ? answer.status ?? answer.statusCode : undefined;
  if (typeof status === 'number') return status >= 200 && status < 400;
  if (answer && typeof answer === 'object' && 'allowed' in answer) return Boolean(answer.allowed);
  throw new TypeError('attempt() must return a boolean, a status code, { status } or { allowed }.');
}

/**
 * L'échange d'identifiants entre deux comptes (BOLA/IDOR) : pour chaque ressource que `owner` possède, `intruder` doit
 * être refusé sur chaque action. Un raccourci de la matrice pour le cas le plus fréquent.
 */
async function assertNoCrossAccountAccess({ owner, intruder, resources, actions = ['read', 'update', 'delete'], attempt, name }) {
  return assertAuthorizationMatrix({
    name: name || 'cross-account access',
    actors: { owner, intruder },
    actions,
    resources,
    expected: ({ actor }) => (actor === 'owner' ? 'allow' : 'deny'),
    attempt,
  });
}

module.exports = { checkAuthorizationMatrix, assertAuthorizationMatrix, assertNoCrossAccountAccess };
