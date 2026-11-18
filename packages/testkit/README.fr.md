# @astratra/testkit

Des essais de sécurité sans dépendance, et trois outils pour des tests qui ne
touchent jamais à la vraie base :

1. des **essais de sécurité** (`@astratra/testkit/security`, ci-dessous) ;
2. une **base jetable** (MongoDB ou Postgres dans un conteneur Docker) ;
3. de **fausses données réalistes par pays**, reproductibles par graine ;
4. un **garde-fou** qui refuse toute URI de base qui ressemble à de la production.

À installer en `devDependency`. Dépendance : `@faker-js/faker` 10 (MIT, pour
les fausses données). Facultatives : `@babel/plugin-transform-modules-commonjs`
(MIT, seulement pour le préréglage Jest ci-dessous, depuis la 2.0.0) ; `@testcontainers/mongodb` et/ou
`@testcontainers/postgresql` (MIT, optionnelles, à n'ajouter que pour le moteur
utilisé — elles apportent `testcontainers`). Node ≥ 22.22 (exigence de
testcontainers 12).

### Avec Jest

`@faker-js/faker` 10 n'existe qu'en module ES (les versions antérieures à 10.5
ont une faille d'exécution de code par `helpers.fake`). Node le charge sans
réglage par `require()`, mais pas le chargeur de Jest en CommonJS. Le paquet
fournit un préréglage qui fait convertir faker, et lui seul, par babel-jest :

```sh
npm install --save-dev @babel/plugin-transform-modules-commonjs
```

```json
{ "jest": { "preset": "@astratra/testkit" } }
```

Si le projet a déjà son propre `transform`, reprends les deux réglages de
`jest-preset.js` (le `transform` babel-jest et le `transformIgnorePatterns`).
Autre voie, sans préréglage : Node ≥ 24.9 et
`NODE_OPTIONS=--experimental-vm-modules jest`.

## Essais de sécurité (`@astratra/testkit/security`)

Treize formes d'essais de sécurité, **sans aucune dépendance** (Node seul),
pour `node:test` comme pour Jest : chaque échec est une `AssertionError` qui
dit quoi rejouer. L'entrée se charge seule, sans faker ni conteneurs.

```js
const { assertFuzz, gen, payloads, assertSafeRegex, assertConstantTime } = require('@astratra/testkit/security');
```

| Forme | Fonctions | Ce qu'elle attrape |
|---|---|---|
| Fuzz | `fuzz`, `assertFuzz`, `gen.*` | plantage, lenteur ou règle violée sur des milliers d'entrées hostiles |
| Catalogue d'attaques | `payloads.*`, `jwtAttacks`, `jwtClaimAttacks`, `forgeJwt` | injections SQL et Mongo, XSS, chemins `../`, en-têtes, Unicode piégé, SSRF, IPv6 d'un même bloc, jetons « none », confusion d'algorithme… |
| Expressions qui s'emballent | `checkRegex`, `assertSafeRegex`, `extractRegexLiterals`, `assertLinearTime` | ReDoS, temps quadratique ou exponentiel |
| Bombes de ressources | `bombs.*`, `checkBounded`, `assertBounded` | gzip qui explose, JSON très profond, texte immense, mémoire ou durée hors limites |
| Différentiel | `compareImplementations`, `assertSameBehavior` | une différence avec la bibliothèque qu'on remplace |
| Vecteurs officiels | `runVectors`, `assertVectors`, `standardVectors`, `fromWycheproof` | écart à une norme (RFC 4226, 6238, 7515 ; fichiers Wycheproof) |
| Métamorphique | `checkRelation`, `assertRelation`, `relations`, `transforms` | une relation cassée (même JSON reformaté, même adresse en majuscules ou décomposée) |
| Propriétés | `checkProperty`, `assertProperty` | une règle fausse, réduite à son plus petit exemple |
| Temps constant | `measureTiming`, `checkConstantTime`, `assertConstantTime` | une comparaison de secret dont la durée trahit le secret (test t de Welch, méthode dudect) |
| Fuites dans les journaux | `captureOutput`, `findSecrets`, `assertNoSecrets` | un secret écrit dans un journal, même en base64, en hexadécimal ou coupé |
| Matrice d'autorisations | `checkAuthorizationMatrix`, `assertAuthorizationMatrix`, `assertNoCrossAccountAccess` | une fiche lisible par un autre compte (BOLA/IDOR), une route d'administration ouverte |
| Courses | `race`, `assertAtMost` | la dernière place vendue deux fois, un code servi deux fois |
| Pannes provoquées | `faults.*`, `withFault`, `assertFailsClosed` | une protection qui s'ouvre quand Redis ou la base tombe |
| Mutations | `runMutations`, `assertMutationsKilled` | un code que les essais ne protègent pas |
| Chaîne d'approvisionnement | `checkLockfile`, `assertLockfile`, `checkDependencyAllowlist`, `assertDependencyAllowlist` | un paquet hors du registre, sans empreinte sha512, qui lance un script à l'installation ; une dépendance non décidée |

### Rejouer un échec

Tout ce qui est tiré au hasard part d'une graine (`seed`, 1 par défaut).
Un échec donne la sienne : `SECURITY_TEST_SEED=<graine>` rejoue exactement les
mêmes entrées.

### Exemples

```js
const { test } = require('node:test');
const security = require('@astratra/testkit/security');

test('le lecteur de jetons ne plante jamais', async () => {
  await security.assertFuzz(lireJeton, {
    generator: security.gen.oneOf(security.gen.hostileString(), security.gen.mutated([jetonValide])),
    runs: 2000,
    // Un refus voulu porte un statut 4xx ou un code à soi ; une TypeError est un plantage.
  });
});

test('aucun jeton piégé n’est accepté', () => {
  for (const { name, token } of security.jwtAttacks(jetonValide, { publicKey })) {
    assert.equal(verifier(token), null, name);
  }
});

test('la comparaison du jeton CSRF ne trahit pas le jeton', () => {
  const vrai = Buffer.from(jeton);
  const fauxAuDebut = Buffer.from('X' + jeton.slice(1));
  const fauxALaFin = Buffer.from(jeton.slice(0, -1) + 'X');
  security.assertConstantTime((candidat) => comparer(candidat, vrai), { classes: [() => fauxAuDebut, () => fauxALaFin] });
});

test('un compte ne lit jamais la fiche d’un autre', async () => {
  await security.assertAuthorizationMatrix({
    actors: { anonyme: null, alice: sessionAlice, bob: sessionBob },
    actions: ['lire', 'modifier', 'supprimer'],
    resources: { noteAlice, noteBob },
    expected: ({ actor, target }) => (actor !== 'anonyme' && target.proprietaire === actor ? 'allow' : 'deny'),
    attempt: ({ context, action, target }) => appeler(context, action, target.id), // rend { status }
  });
});

test('la dernière place ne part qu’une fois', async () => {
  await security.assertAtMost(() => reserver(evenementUnePlace), { max: 1, concurrency: 50 });
});

test('la limite reste fermée quand Redis tombe', async () => {
  await security.assertFailsClosed(clientRedis, 'eval', security.faults.rejecting(), () => appelerUneRoute());
});
```

### Limites, dites franchement

- Le **temps constant** est un indice statistique, pas une preuve : une mesure
  sans fuite ne démontre rien. Les tampons sont recopiés avant chaque mesure
  (une même adresse fausse le résultat par le seul effet du cache), et une fuite
  doit se voir à chaque tentative (`attempts`, 3 par défaut).
- Le **fuzz** est tiré au hasard, sans couverture du code (pas d'instrumentation
  comme Jazzer.js) ; il complète les essais écrits, il ne les remplace pas.
- `checkRegex` essaie des attaques devinées d'après l'expression, chacune dans
  un fil arrêté net après le temps permis ; une expression qui passe n'est pas
  prouvée sûre pour toutes les entrées. `assertLinearTime` mesure dans le
  processus même : on part de petites tailles.
- `fromWycheproof` lit les fichiers du projet Wycheproof (C2SP, licence
  Apache-2.0), à télécharger depuis son dépôt ; ils ne sont pas recopiés ici.

## Base jetable

```js
const { startMongo, startPostgres, isDockerAvailable } = require('@astratra/testkit');

let db;
beforeAll(async () => {
  db = await startMongo({ database: 'app_test' }); // image mongo:8, replica set à un nœud
  process.env.MONGODB_URI = db.uri;                    // mongodb://127.0.0.1:PORT/app_test?directConnection=true
}, 120_000);
afterAll(() => db.stop());
```

`startPostgres()` (image `postgres:17-alpine`) rend `{ uri, stop }` de la même
façon. Si Docker est absent, `isDockerAvailable()` renvoie `false` : saute la
suite proprement (`const suite = isDockerAvailable() ? describe : describe.skip`).
Le conteneur démarre sur un port aléatoire, l'URI obtenue est elle-même passée
au garde-fou, et un conteneur dont l'URI serait refusée est arrêté aussitôt.

## Fausses données par pays

```js
const { createFakeData } = require('@astratra/testkit');

const data = createFakeData({ country: 'CD', seed: 42 });
data.person();            // { firstName, lastName, birthDate, email, phone: '+243 81 234 5678', address, … }
data.people(30, { minAge: 6, maxAge: 12 });
data.organization();
data.faker;               // l'instance faker graînée, pour le reste
```

Pays : `CD` (RDC, listes écrites ici car faker n'a pas de locale), `FR`, `BE`,
`CH`, `CA`, `SN`, `US`, `GB`, `GH`, `NG`, `ZA`, `IN`, `ES`, `MX`, `PT`, `BR`,
`DE`, `IT`, `JP`, `KR` (`supportedCountries()`). Noms et adresses suivent la
locale de faker ; les téléphones suivent le plan de numérotation du pays.

- **Reproductible** : même pays + même graine = même suite, à l'octet près. La
  date de référence des âges est fixe (1er janvier 2026), sinon la graine ne
  reproduirait rien d'une année à l'autre.
- **Sans risque** : les e-mails sont en `@example.test` (domaine réservé).
- La géographie n'est pas toujours cohérente (une ville et une région tirées
  indépendamment) : ce sont des données de test, pas un annuaire.

## Garde-fou

```js
const { assertSafeTestDatabaseUri } = require('@astratra/testkit');

assertSafeTestDatabaseUri(process.env.MONGODB_URI); // lance UnsafeTestDatabaseError, avec .reason
```

Refusé, dans l'ordre : `NODE_ENV=production` ; hébergeur géré (Atlas, RDS,
Supabase, Neon… — **même listé**) ; schéma `mongodb+srv` ; « prod »,
« production » ou « live » dans l'hôte ou le nom de base ; hôte distant (ni
boucle locale, ni `.test`/`.localhost`, ni nom de service sans point) sauf s'il
figure dans `allowRemoteHosts` **et** que la base porte « test » dans son nom ;
URI identique à `MONGODB_URI`/`DATABASE_URL`… de l'environnement sans nom de base
marqué test. Appelle-le au début de ton `globalSetup` : une suite qui vide des
collections ne doit jamais découvrir trop tard où elle est branchée.

## Limite

Le test de conteneurs réel de ce paquet n'est exécuté que si un démon Docker
répond ; sinon il est ignoré (les doublures testent le reste du chemin).

## Évaluation de comportements

`evaluateAgent({ scenarios, run, signal? })` rend `{ results, score, passed, total }`.
Chaque scénario donne `id`, `question`, des `tools` simulés, des attentes
`expect: { tools: ['nom'], content: ['texte', /motif/] }` et éventuellement
`score({ text, calls, output, checks })`, une note entre 0 et 1.
Le lanceur injecté reçoit `{ question, tools, signal }` et rend un texte ou
`{ text }`. Les appels sont enregistrés. La note globale est la moyenne ;
les erreurs donnent zéro, l'annulation est propagée. Le rapport s'utilise
avec des assertions `node --test`. Voir le README anglais pour un exemple.
