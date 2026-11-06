# @astratra/web-search

Une recherche web pour les IA, où chaque fait reste attaché à sa page.

Plusieurs moteurs (Serper pour les résultats Google, Brave Search, Tavily, Exa,
ou une passerelle de recherche à vous) avec repli automatique ; leurs **classements**
sont fusionnés, leurs **contenus jamais**. Chaque résultat est une page d'un
site, avec son adresse exacte, son domaine, sa date quand on la connaît,
l'extrait d'**un seul** moteur pour **cette** page et, quand la page est lue,
des passages cités mot pour mot avec leur position. Les pages sont lues sans
ouvrir de porte vers votre réseau interne (SSRF), et tout ce qu'un modèle lit
du web lui est présenté comme des données, pas comme des instructions.

[English version](README.md)

```bash
npm install @astratra/web-search
```

## Pourquoi

Un assistant qui cherche seul prend en général les premiers résultats d'un
moteur et colle des extraits. Trois défauts en sortent : le bon site manque
parce qu'un moteur l'a mal classé, la même page revient trois fois sous trois
adresses, et la réponse mêle des phrases de pages différentes sans dire d'où
vient chacune. Ce paquet corrige les trois, et chacun se vérifie (voir
[Évaluation](#évaluation)).

## Démarrage

```js
const { createWebSearch, gatewayProvider, braveProvider, formatForModel } = require('@astratra/web-search');

const ws = createWebSearch({
  providers: [
    gatewayProvider({ search: (demande, { signal }) => maPasserelle.rechercher(demande, { signal }) }),
    braveProvider({ key: () => process.env.BRAVE_SEARCH_API_KEY })
  ]
});

const trouve = await ws.search({ query: 'arroser les tomates', lang: 'fr', freshness: 'auto', read: 2 });
trouve.results[0];
// { id: 'S1', title, url, canonicalUrl, domain, publishedAt, dateSource, snippet, snippetFrom: 'gateway',
//   foundBy: ['gateway', 'brave'], ranks: { gateway: 1, brave: 3 }, score,
//   page: { status: 'read', passages: [{ text, start, end }], … } }
trouve.report;          // moteurs essayés et utilisés, échecs, coût estimé, temps, cache
formatForModel(trouve); // le texte pour le modèle : règles de citation, puis les sources dans un cadre de données
```

## Ce qui est garanti

- **Aucune fusion des contenus.** Les classements sont fusionnés par
  Reciprocal Rank Fusion (`1 / (60 + rang)` par liste). Le titre, l'extrait et
  les extraits en plus d'un résultat viennent tous du seul moteur qui a le
  mieux classé cette page, nommé dans `snippetFrom`. Les extraits de deux
  moteurs ne sont jamais collés, même pour la même page. Une date donnée par un
  autre moteur pour **la même** page est gardée, et `dateSource` dit lequel.
- **Une entrée = une page = un site.** Le dédoublonnage se fait par page
  canonique : hôte sans `www.`, sans fragment ni paramètres de suivi (`utm_*`,
  `gclid`…), paramètres triés, sans barre finale. Quand les pages sont lues,
  leur `<link rel="canonical">` (du même site seulement) réunit deux adresses
  d'une même page. Deux pages différentes ne sont jamais réunies, même
  semblables.
- **Les passages sont mot pour mot.** `passages[i].text === texteDeLaPage.slice(start, end)`,
  toujours. `ws.read(url, { quotes })` dit pour chaque citation si la page la
  contient (`found`, `exact`, position), ou `found: false`.
- **Une redirection vers un autre site n'est pas la page du résultat.** Son
  texte n'est pas rattaché (`page.status: 'other_site'`).
- **Les filtres sont revérifiés à l'arrivée.** `sites`, `excludeSites`, les
  domaines bloqués et la fenêtre de fraîcheur partent vers chaque moteur sous sa
  forme à lui, puis sont revérifiés sur ce qui revient.

## Les moteurs

| Fournisseur | Adresse | Notes |
|---|---|---|
| `gatewayProvider({ search })` | une passerelle de recherche à toi | Les clés des moteurs restent chez ta passerelle, qui compte le coût (`costPerCallUsd: null`). Les sites partent en opérateurs `site:`. |
| `serperProvider({ key })` | `google.serper.dev` | Réutilise `searchSerper` de `@astratra/ai`. Pays (`gl`), langue (`hl`), période (`tbs`). |
| `braveProvider({ key })` | `api.search.brave.com/res/v1/web/search` | Index indépendant. `extra_snippets` de la même page, `freshness`. Brave réserve le stockage des résultats aux forfaits qui l'incluent : le cache de ce moteur est d'une minute par défaut. |
| `tavilyProvider({ key })` | `api.tavily.com/search` | Filtres de domaines natifs, `time_range`. `search_depth: 'basic'` (1 crédit) est fixé. La réponse générée (`answer`) n'est jamais demandée. |
| `exaProvider({ key })` | `api.exa.ai/search` | Recherche par le sens, `highlights` tirés de la page, `publishedDate`. Le coût rendu par Exa (`costDollars.total`) est repris. Le résumé généré (`summary`) n'est jamais demandé. |

Une clé est une chaîne ou une fonction lue à chaque appel (rotation sans
redémarrage). Elle part dans un en-tête, jamais dans une adresse, et
n'apparaît dans aucune erreur, aucun compte rendu, aucune sortie d'outil. Un
moteur à vous est un objet
`{ id, costPerCallUsd, search(request, { signal, now }) => { hits } }`.

## Modes, repli, coût

- `mode: 'fuse'` (défaut) : les `fuseCount` (2) premiers moteurs disponibles
  répondent ensemble ; un moteur en panne est remplacé par le suivant de la liste.
- `mode: 'fallback'` : un moteur à la fois, le suivant seulement si le
  précédent échoue ou ne trouve rien (`fallbackOnEmpty`).
- Une panne de réseau ou une 5xx est retentée une fois (`retry`), après une
  attente. Une 4xx ne l'est pas. Une 402 ou une 429 met le moteur au repos
  (`cooldownMs`, 60 s).
- `quotas: { brave: { perMinute, perDay, perMonth } }` (fenêtres fixes ;
  `perMonth` vaut 30 jours) ; `quotaStore` et `cache` prennent votre Redis ou
  votre base (`{ get, incr }`, `{ get, set }`).
- `budgetMs` (25 s) borne une recherche entière, lectures comprises.
- `report.costUsd` est le coût estimé des appels partis (le cache coûte 0).
  `costComplete: false` : un moteur ne donne pas son coût (la passerelle le
  compte de son côté).

## Qualité

- `freshness: 'day' | 'week' | 'month' | 'year'` est un filtre. `'auto'`
  (défaut) ne filtre rien, mais quand la question demande du récent
  (« aujourd'hui », « dernière version », « actuel », l'année en cours…), les
  pages récentes reçoivent un bonus qui décroît avec l'âge.
- `site:` et `-site:` écrits dans la requête deviennent des filtres.
- `ranking: { blockDomains, preferDomains (×1,5), demoteDomains (×0,5), domainScore(domain), maxPerDomain (2) }`.
- `rewrite: async (request) => nouvelleRequete` branche votre propre
  réécriture ; les filtres sont gardés, et `report.rewrittenQuery` montre ce
  qui est parti.
- `extract: (html, { url }) => ({ text, title?, publishedAt?, canonical? })`
  branche un autre extracteur (Readability…). Celui du paquet, sans
  dépendance, garde `<article>`, `<main>` ou `role="main"` et retire scripts,
  menus, pieds de page, bandeaux de cookies, boutons de partage et publicités.

## Lire les pages sans risque

`ws.read(url, { quotes, query })` et `search({ read: n })` passent par
`safeFetch` :

- https seulement, port 443 (ou `reading.ports`), sans identifiants dans l'adresse ;
- le nom est résolu **avant** la connexion, et la connexion part vers
  l'adresse vérifiée elle-même (par le `lookup` de `https.request`) : un DNS
  rebinding n'y gagne rien. Si **une** adresse du nom est interne, la lecture
  est refusée. Refusés : boucle locale, réseaux privés, link-local (dont les
  métadonnées des nuages, 169.254.169.254), CGNAT, multicast, plages réservées
  et de documentation ; en IPv6, tout ce qui n'est pas unicast global, les
  IPv4 encapsulées, NAT64, 6to4, Teredo, ULA et link-local. Les noms comme
  `localhost`, `*.local` ou `*.internal` sont refusés sans résolution ;
- les redirections sont suivies à la main, chacune revérifiée, 5 au plus ;
- un délai pour toute la lecture ; une taille maximale comptée **après**
  décompression (2 Mo ; au-delà, la page est coupée, `truncated: true`) ;
- seulement `text/html`, `application/xhtml+xml` et `text/plain`.

## Brancher un modèle

```js
const { toolDefinitions, nativeTools, registryTools } = require('@astratra/web-search');

toolDefinitions('anthropic');   // [{ name: 'web_search', description, input_schema }, { name: 'read_page', … }]
toolDefinitions('openai');      // [{ type: 'function', function: { name, description, parameters } }, …] (et 'mistral')
toolDefinitions('gemini');      // [{ functionDeclarations: [...] }], schéma nettoyé par geminiSchema de @astratra/ai
```

- **`runToolLoop` de `@astratra/ai`** : `nativeTools(ws)` donne des outils
  `read`, de risque `LOW`, qui rendent `{ data, sources }`. Chaque source est
  `{ kind: 'web', id, url, title, domain, publishedAt, excerpt }` : elle va
  dans `createSourceLedger`, et `kind: 'web'` permet à `readsUntrusted` de
  marquer l'exécution comme exposée. Le texte tient en 5 000 caractères, sous
  les 6 000 où `createToolCaller` coupe : le cadre n'est jamais coupé.
- **`runAgentLoop` de `@astratra/ai`** : `registryTools(ws, { roles })`
  inscrit `type: 'read'`, `risk: 'LOW'`, `external: true` (la requête sort de
  l'application : le masque des données personnelles s'y applique).
- **MCP** : `createMcpServer(ws)` de `@astratra/web-search/mcp` (il faut
  `@modelcontextprotocol/sdk`) sert les deux mêmes outils, marqués en lecture
  seule. Un serveur stdio prêt à l'emploi lit ses moteurs dans l'environnement :

```bash
SERPER_API_KEY=… npx astratra-web-search-mcp
```

  L'environnement est lu dans cet ordre : `SERPER_API_KEY`,
  `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`.
  `WEB_SEARCH_MODE=fallback` pour un moteur à la fois.

Ce que lit le modèle : les règles de citation (citer `[S1]`, ne jamais
attribuer les mots d'une source à une autre) **hors** du cadre ; les sources,
avec leur adresse, leur site, leur date, leur extrait et leurs passages mot
pour mot, **dans** un cadre de données non fiables dont la marque aléatoire ne
peut pas être refermée par la page. Le texte entier ne dépasse jamais `maxChars`.

## Évaluation

`runEvaluation({ cases, search, recorder, readText })` vérifie, pour chaque
cas : `noMixing` (chaque titre et chaque extrait sont exactement ceux que le
moteur nommé a donnés pour cette page), `noDuplicates`, `passagesVerified`
(chaque passage est à sa place dans sa page), et selon le cas
`expectedDomain` (le bon site dans les `within` premiers), `recentFirst` et
`forbiddenDomains`.

Les tests la font tourner sur un corpus fixe dont les moteurs simulés ont les
défauts des vrais. L'outil passe les 6 cas. La recherche brute d'un seul
moteur en rate 4 (bon site absent des 3 premiers, doublons, page ancienne en
tête, site exclu gardé), et coller les extraits par titre rate `noMixing`.
Contre les vrais moteurs (rien n'est appelé sans clé, et les clés ne sont
jamais affichées) :

```bash
SERPER_API_KEY=… BRAVE_SEARCH_API_KEY=… npm run eval:live -w @astratra/web-search
```

## Ce qu'il ne fait pas

- Il n'écrit pas de réponse. Il donne des pages ; le modèle répond et cite.
- Il n'exécute pas le JavaScript des pages : une page entièrement construite
  dans le navigateur donne peu de texte. Branchez votre `extract`, ou lisez ces
  pages autrement.
- Il ne lit ni les PDF ni les images.
- Il ne contourne ni les murs payants, ni les règles des robots, ni les
  conditions des moteurs. Vérifiez les conditions de chaque moteur utilisé,
  notamment sur le stockage des résultats.
- La date d'une page est celle que donne le moteur ou la page ; elle peut
  manquer ou être fausse (`publishedAt: null` plutôt qu'une date devinée).
- L'extracteur du paquet est volontairement simple ; sur une mise en page
  complexe, il peut garder un peu de bruit ou manquer du texte.

## Tests

```bash
npm test -w @astratra/web-search
```

Les tests n'appellent jamais Internet : les moteurs sont simulés, et les
lectures de pages passent par un réseau simulé qui utilise le même `lookup`
que le vrai.
