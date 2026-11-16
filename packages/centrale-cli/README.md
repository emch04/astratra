# @astratra/centrale-cli

L'outil en ligne de commande d'un tableau de bord de surveillance auto-hébergé : il relie les erreurs minifiées à leur vraie ligne (cartes de code, par identifiant de débogage) et déclare les déploiements (version d'apparition, commit suspect). Aucune dépendance à l'exécution.

## Installation

```sh
npm install --save-dev @astratra/centrale-cli
```

Node 22 ou plus récent. La commande `centrale` est alors disponible via `npx centrale`.

## Commandes

```sh
export CENTRALE_ADRESSE=https://centrale.exemple.fr
export CENTRALE_JETON=clj_dep_…            # jeton de DÉPLOIEMENT du projet (secret de CI)

npx centrale injecter dist                 # après le build, avant la mise en ligne
npx centrale envoyer-cartes dist --version 2.14.0
npx centrale deploiement --version 2.14.0 --commit "$GITHUB_SHA" --depot exemple/app --environnement production

# Apps Apple (iOS, macOS), sur le Mac qui archive, avec Xcode :
npx centrale envoyer-symboles build/App.xcarchive --version 2.14.0
```

| Commande | Ce qu'elle fait |
| --- | --- |
| `injecter <dossier>` | Pour chaque `.js`/`.mjs`/`.cjs` qui a une carte (commentaire `sourceMappingURL` ou `<fichier>.map`) : calcule un identifiant stable (SHA-256 du contenu, mis en forme d'UUID), insère en tête une ligne qui l'enregistre dans `globalThis.__centraleDebugIds`, ajoute `//# debugId=<id>` en fin de fichier et `debug_id` dans la carte. Relancer ne change rien. |
| `envoyer-cartes <dossier> --version X` | Demande au backend les cartes qu'il a déjà, puis envoie les autres par lots compressés (16 Mio visés, 64 Mio au plus). Coupure, 5xx et 429 sont réessayés avec recul (`Retry-After` respecté). Relancer reprend où l'envoi s'est arrêté. |
| `envoyer-symboles <archive \| .dSYM> [--version X] [--racine dossier]` | Pour chaque binaire des dSYM (et chaque architecture), une **table de symboles** : fonctions, fichiers et lignes, en décalages depuis le segment `__TEXT`, rangée par l'UUID du binaire. Les plantages et erreurs du paquet Swift portent cet UUID : le tableau de bord traduit lui-même « App +5552808 » en fonction, fichier et ligne, sans recevoir le dSYM. Demande d'abord les tables déjà connues. Voir plus bas. |
| `deploiement --version X --commit SHA` | Déclare un déploiement. `--environnement` vaut par défaut celui du jeton. Déclarer deux fois le même ne crée pas de doublon. |

| Option | Commande | Rôle |
| --- | --- | --- |
| `--version X` | `envoyer-cartes`, `deploiement` | Version de l'app (obligatoire). |
| `--commit SHA` | `deploiement` | Commit déployé (obligatoire). |
| `--depot proprietaire/depot` | `deploiement` | Dépôt de code, par exemple `exemple/app`. |
| `--environnement nom` | `deploiement` | Environnement ; par défaut, celui du jeton. |

Les variables `CENTRALE_ADRESSE` (adresse du backend, en `http(s)://`) et `CENTRALE_JETON` (jeton de déploiement `clj_dep_…`) sont lues pour `envoyer-cartes` et `deploiement`.

Codes de sortie : `0` réussi, `1` échec (réseau, jeton refusé, carte refusée), `2` commande mal formée.

## Comment l'identifiant voyage

1. `injecter` place en tête de chaque fichier (après `#!` et les directives `"use strict"`, `"use client"`, sur la même ligne pour ne décaler aucun numéro de ligne ; les colonnes de la carte sont recalées) :
   `globalThis.__centraleDebugIds[new Error().stack] = "<id>"`.
2. Au chargement, la pile capturée contient l'adresse réelle du fichier (domaine, hash du build compris).
3. `@astratra/centrale` relit ces piles avec le même analyseur que les erreurs : chaque cadre reçoit le `debugId` de son fichier (et l'erreur aussi, s'il n'y en a qu'un).
4. Le backend traduit les cadres avec la carte de même identifiant **du même projet**, à la lecture du détail d'un problème.

Sans identifiant (bytecode Hermes, build non injecté), le backend cherche une carte de **la même version** dont le chemin finit comme celui du cadre : nommez la carte comme le fichier des piles (par exemple `index.android.bundle.map` pour Expo/React Native).

## Les tables de symboles Apple

`envoyer-symboles` utilise les outils de Xcode (`xcrun`) : `dwarfdump --uuid` (l'UUID de chaque architecture, celui des rapports d'Apple), `otool -l` (l'adresse du segment `__TEXT`), `dwarfdump --debug-line` (les plages de code décrites), `atos` (la référence d'Apple, qui tient compte du code déplié) et `nm` avec `swift-demangle` (le début de chaque fonction, même sans informations de débogage). Sur arm64, **chaque instruction** des plages décrites est traduite par `atos` et seuls les changements sont gardés : la table rend la même fonction, le même fichier et la même ligne qu'`atos`. Sur x86_64 (instructions de longueur variable), le début de chaque ligne de code.

Les chemins sous `--racine` (le dossier courant par défaut) deviennent relatifs ; les autres ne gardent que leurs deux derniers segments : aucun nom d'utilisateur ni chemin de la machine ne part. Une app d'une centaine de milliers de lignes de code donne une table de quelques Mo (moins de 1 Mo compressée), extraite en quelques secondes.

## Exemples de build

- **Vite / Astro** : `build.sourcemap: true` (ou `'hidden'` pour ne pas publier le commentaire), puis `centrale injecter dist`. Ne mettez pas les `.map` en ligne : supprimez-les après `envoyer-cartes`.
- **Node compilé** (tsc, esbuild) : `sourceMap: true`, puis `centrale injecter build`.
- **Expo / Hermes** : exportez avec les cartes (`npx expo export --dump-sourcemap`), puis `centrale injecter dist` (la carte reçoit son identifiant) et `centrale envoyer-cartes dist --version <version de l'app>`.

## Bibliothèque

```ts
import { injecterDossier, envoyerCartes, declarerDeploiement } from '@astratra/centrale-cli';
```

`extraireTables(chemin, { racine })` rend les tables de symboles d'une archive ou d'un dSYM, `envoyerSymboles(connexion, tables, { version })` les envoie. `envoyerCartes(connexion, { dossier, version })` et `declarerDeploiement(connexion, { version, commit, depot?, environnement? })` prennent une `connexion` `{ adresse, jeton }`. `injecterDossier(dossier)` rend la liste des fichiers traités.

Le paquet est écrit en TypeScript à syntaxe effaçable (Node 22.18 ou plus l'exécute directement dans le dépôt) ; il est compilé en JavaScript au moment de sa publication, comme `@astratra/centrale`.

## Ce que l'outil ne fait pas

- Il ne lance pas le build et ne supprime pas les cartes après l'envoi : c'est à votre CI de le faire.
- Il n'envoie ni erreurs ni événements : c'est le rôle de `@astratra/centrale`.
- Il ne gère pas les cartes de feuilles de style (`.css.map`), laissées de côté.

## Licence

MIT.

## Tests

```sh
npm test -w @astratra/centrale-cli
```
