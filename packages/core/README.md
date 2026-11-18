# @astratra/core

Briques de base partagées, indépendantes de tout framework, utilisées par
tous les autres packages Astratra : format de réponse API, gestion
d'erreurs, logs, identifiant de requête, validation et chargement de
variables d'environnement. Aucune base de données, aucun ORM, aucune
logique métier.

## Installation

Dans le monorepo, les autres packages en dépendent via `file:../core`. Hors
monorepo, ce serait une dépendance npm classique une fois publié.

## Contenu

```js
const {
  apiResponse,        // (res, statusCode, message, data, success) => envoie une réponse JSON unifiée
  asyncHandler,        // (fn) => wrapper middleware Express qui transmet les erreurs à next()
  createLogger,        // (serviceName) => { info, warn, error, debug } — no-op si NODE_ENV=test
  AppError,             // classe AppError extends Error — porte un statusCode
  errorMiddleware,      // gestionnaire d'erreurs Express — masque message/stack en production, logge les 5xx via req.log ou console
  notFoundMiddleware,   // gestionnaire 404 Express via apiResponse
  requestIdMiddleware,  // attache req.requestId (header X-Request-Id, respecte un id entrant)
  validateMiddleware,   // (validations) => lance des chaînes de validation, 400 si échec
  body, param, query, header, cookie, check, // chaînes de validation, comme express-validator
  validationResult, matchedData,
  loadEnv,               // (schema) => lit process.env avec valeurs par défaut/requis/transform/validate
  idempotencyMiddleware, // (options) => une écriture rejouée avec la même clé ne s'exécute qu'une fois
  createIdempotency,     // (options) => le même moteur, hors HTTP (tâches, files, RPC)
  createMemoryIdempotencyStore,
  createGoogleServiceAccountAuth, // ({ credentials, scopes }) => { getAccessToken, request } — jeton d'un compte de service Google
  createUpload,          // ({ limits, fileFilter }) => { single, array, fields, none, any } — téléversements, sans multer
  detectFileType         // (buffer) => { ext, mime } | null — le vrai type d'un fichier, par ses premiers octets
} = require('@astratra/core');
```

## Exemple

```js
const express = require('express');
const { apiResponse, asyncHandler, errorMiddleware, notFoundMiddleware, requestIdMiddleware, AppError } = require('@astratra/core');

const app = express();
app.use(requestIdMiddleware);

app.get('/ping', asyncHandler(async (req, res) => {
  return apiResponse(res, 200, 'pong', { requestId: req.requestId });
}));

app.get('/boom', asyncHandler(async () => {
  throw new AppError('Quelque chose de précis a cassé', 400);
}));

app.use(notFoundMiddleware);
app.use(errorMiddleware);
```

`errorMiddleware` logge les erreurs serveur (5xx) via `req.log.error` si
disponible, sinon `console.error`, et ne logge jamais les erreurs client
(4xx).

## Clé idempotente

Un double appui sur « Payer », une application mobile qui rejoue sa file hors
ligne, un proxy qui retente après un délai : la même écriture arrive deux fois.
Le client génère UNE clé par intention (pas par tentative) et l'envoie dans
l'en-tête `Idempotency-Key` à chaque tentative. Le serveur exécute la première ;
les suivantes reçoivent la réponse conservée, avec l'en-tête
`Idempotent-Replay: true`, sans rien refaire.

```js
const { idempotencyMiddleware } = require('@astratra/core');

app.use('/api', authenticate); // AVANT : l'identité doit être vérifiée
app.use('/api', idempotencyMiddleware({
  store,                                  // voir « Le store » ci-dessous
  ttlMs: 24 * 60 * 60 * 1000,             // durée de vie d'une clé (défaut 24 h)
  identify: (req) => req.user?.id ?? null // identité STABLE : le compte, jamais le jeton
}));
```

Hors HTTP, le même moteur :

```js
const { createIdempotency } = require('@astratra/core');
const once = createIdempotency({ store, ttlMs: 60 * 60 * 1000 });
const { replayed, result } = await once.run(
  { scope: [accountId], key, payload: order },
  () => charge(order)
);
```

### Les décisions encodées, chacune testée

| Situation | Réponse |
|---|---|
| Pas d'en-tête, ou méthode de lecture | rien ne change, la requête passe |
| Clé jamais vue | exécutée, la réponse est retenue AVANT d'être envoyée |
| Même clé, même corps, déjà terminée | réponse conservée, rien n'est refait |
| Même clé, première encore en cours (requêtes simultanées) | `409` |
| Même clé, corps différent | `422` — jamais la réponse d'une autre demande |
| Réponse hors 2xx, ou exception | clé libérée : la tentative suivante s'exécute vraiment |
| Clé expirée pas encore purgée par le store | libérée puis réclamée, pas de faux « en cours » |
| Clé invalide (hors `[A-Za-z0-9_-]{8,128}`) | `400` |
| Store indisponible | `503` par défaut ; `onStoreError: 'allow'` laisse passer sans garde |

- **La réclamation est atomique.** L'enregistrement est inséré « s'il
  n'existe pas » AVANT l'exécution : c'est cette insertion qui départage deux
  requêtes simultanées, jamais une lecture suivie d'une écriture.
- **L'appelant fait partie de la clé.** `identify` est obligatoire. Prenez un
  identifiant VÉRIFIÉ (compte authentifié, ou jeton vérifié dans `identify`) :
  un identifiant simplement décodé permet de se faire passer pour un autre et
  de récupérer sa réponse. `null` place l'appel dans un espace anonyme commun,
  où seuls la clé et le corps séparent les appelants.
- **Le corps est comparé sans condition**, avec un hachage insensible à
  l'ordre des propriétés.
- **La réponse est stockée telle quelle** pendant `ttlMs`. Ne montez pas le
  middleware sur une route qui renvoie un secret (jeton de session, code de
  récupération) : il resterait en clair dans le store.

### Le store

Trois méthodes, pour n'importe quelle base :

```js
{
  acquire(id, entry),          // insertion ATOMIQUE si absent -> { acquired, record }
  complete(id, token, response), // passe à « done », seulement si le jeton de réclamation correspond
  release(id, token)             // supprime, seulement si le jeton correspond
}
```

MongoDB : `_id` unique + `insertOne` (erreur 11000 = déjà présent, relire),
index TTL sur `expiresAt`, `updateOne({ _id, token })`, `deleteOne({ _id, token })`.
Redis : `SET id entry NX PX ttl`. SQL : `INSERT … ON CONFLICT DO NOTHING`.
Le conditionnement par `token` n'est pas décoratif : sans lui, une tentative
lente qui libère une clé expirée efface la réclamation toute neuve d'une autre,
et les deux s'exécutent.

`createMemoryIdempotencyStore()` sert aux tests : il n'est ni persistant ni
partagé entre instances.

### Ce que ce module ne fait pas

- Une requête dont le processus meurt en cours d'exécution laisse sa clé
  « en cours » jusqu'à expiration : on préfère un `409` à un double paiement.
- Il ne protège pas les webhooks d'un prestataire de paiement : voir
  `@astratra/payments`, qui les reconnaît par l'identifiant d'événement.

## Jeton d'un compte de service Google

Le jeton d'accès d'un compte de service Google (Wallet, Play, Firebase…), sans
google-auth-library : un JWT signé en RS256 avec la clé du compte, échangé contre
un jeton d'accès (RFC 7523).

```js
const { createGoogleServiceAccountAuth } = require('@astratra/core');

const google = createGoogleServiceAccountAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/wallet_object.issuer']
});
const token = await google.getAccessToken();
const { data } = await google.request({ method: 'GET', url: 'https://walletobjects.googleapis.com/walletobjects/v1/issuer' });
```

- Le jeton est gardé jusqu'à cinq minutes avant son échéance ; des demandes
  simultanées partagent un seul échange. `request()` rejoue une fois après un 401
  avec un jeton neuf ; une réponse d'erreur lève `GoogleAuthError`
  (`GOOGLE_API_ERROR`, avec `response.status` et `response.data`).
- L'adresse d'échange (`token_uri`) n'est acceptée qu'en https sur
  `googleapis.com` : un fichier de compte de service modifié ne peut pas envoyer
  l'assertion signée ailleurs. `allowedTokenUris` en permet une autre (émulateur).
- Une clé collée avec des `\n` écrits en toutes lettres est acceptée. Aucun
  message d'erreur ne reprend la clé, l'assertion ou le jeton ; chaque appel à
  Google a un délai (`timeoutMs`, 15 s).

## Téléversement de fichiers

Le téléversement (`multipart/form-data`), lu au fil du flux et gardé en mémoire,
sans multer ni busboy. Les mêmes usages que multer en mémoire, les mêmes codes
d'erreur (`LIMIT_FILE_SIZE`, `LIMIT_UNEXPECTED_FILE`…, avec `status` 400 ou 413) :

```js
const { createUpload, detectFileType } = require('@astratra/core');

const upload = createUpload({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
app.post('/photos', upload.single('photo'), (req, res) => {
  const type = detectFileType(req.file.buffer);           // le type annoncé (req.file.mimetype) n'est pas une preuve
  if (!type || !['jpg', 'png', 'webp'].includes(type.ext)) return res.status(400).end();
  // req.file : fieldname, originalname (sans chemin), safeName, mimetype, size, buffer ; req.body : les autres champs
});
```

- Des limites par défaut (multer n'en avait aucune) : 10 Mio par fichier, 10
  fichiers, 100 champs, 1 Mio par champ, 200 parties, 50 Mio au total.
- Comparé à multer 2.4.0 sur 191 formulaires enregistrés : quand les deux
  acceptent, mêmes champs et mêmes fichiers, octet pour octet. Écarts voulus :
  noms lus en UTF-8 (multer donnait « Ã©lÃ¨ve »), champ `__proto__`,
  `constructor` ou `prototype` refusé, en-tête répété dans une partie refusé,
  partie sans `Content-Disposition` refusée, et rien n'est lu après la
  frontière finale (busboy continuait).
- Un corps interrompu, des en-têtes trop longs ou une frontière absente sont des
  erreurs 400, jamais une attente sans fin ; au-delà de la limite totale, le
  reste du corps n'est pas gardé.

## Valider une requête

Les chaînes de validation, à la manière d'express-validator 7, sans dépendance : mêmes méthodes, mêmes erreurs,
mêmes nettoyages écrits dans la requête. Un projet qui utilisait express-validator change seulement son `require`.

```js
const { body, param, validationResult, matchedData, validateMiddleware } = require('@astratra/core');

router.post('/inscription',
  body('email').trim().isEmail().normalizeEmail().withMessage('Adresse invalide'),
  body('age').optional().isInt({ min: 13 }).toInt(),
  body('password').isLength({ min: 12 }).hide(),           // l'erreur ne renvoie pas le mot de passe
  body('enfants.*.nom').trim().notEmpty(),                  // chaque élément d'un tableau
  (req, res) => {
    const result = validationResult(req);
    if (!result.isEmpty()) return res.status(400).json({ errors: result.array() });
    return res.json(matchedData(req));                       // seulement les champs validés
  });

router.patch('/reglages/:key', validateMiddleware([param('key').trim().notEmpty().isLength({ max: 200 })]), handler);
```

Vérifications : `exists`, `notEmpty`, `isEmpty`, `isString`, `isArray`, `isObject`, `isBoolean`, `isEmail`,
`isLength`, `isInt`, `isFloat`, `isNumeric`, `isIn`, `isMongoId`, `isUUID`, `isHexadecimal`, `isIP`, `isFQDN`,
`isByteLength`, `contains`, `equals`, `matches`, `custom`. Nettoyages : `trim`, `ltrim`, `rtrim`, `escape`,
`unescape`, `normalizeEmail`, `toInt`, `toFloat`, `toBoolean`, `toDate`, `toLowerCase`, `toUpperCase`, `stripLow`,
`blacklist`, `whitelist`, `toArray`, `default`, `replace`, `customSanitizer`. Et `optional`, `not`, `bail`, `if`,
`withMessage`, `hide`. Une méthode absente (`isURL`…) échoue au démarrage de l'application, pas à la première
requête.

Plus sûr qu'express-validator :

- **Aucune écriture sur un prototype** : un champ ou un joker vers `__proto__`, `constructor` ou `prototype`
  n'est jamais lu ni écrit, et seules les propriétés propres de la requête sont lues.
- **Aucune requête ne fait planter la validation** : un corps JSON comme `{"v":{"toString":0}}` ou
  `{"v":[[{"toString":1}]]}`, ou un texte avec un demi-caractère Unicode, faisait lever une exception à
  express-validator (une erreur 500) ; ici la valeur est simplement invalide.

Dans Express 5, `req.query` est recalculé à chaque lecture : un nettoyage ne s'y écrit pas (pas plus qu'avec
express-validator). La valeur nettoyée se lit dans `matchedData(req)`.

Le code vient en partie de validator.js et d'express-validator (licence MIT) : voir `THIRD-PARTY-NOTICES.md`.

## Tests

```bash
npm test --workspace @astratra/core
```
