# @astratra/web-search

Une recherche web pour les IA, où chaque fait reste attaché à sa page.

Plusieurs moteurs (Serper pour les résultats Google, Brave Search, Tavily, Exa,
ou une passerelle de recherche à vous) avec repli automatique ; leurs **classements**
sont fusionnés, leurs **contenus jamais**. Chaque résultat est une page d'un
site, avec son adresse exacte, son domaine, sa date quand on la connaît,
l'extrait d'**un seul** moteur pour **cette** page et, quand la page est lue,
des passages cités mot pour mot avec leur position. Les pages sont lues sans
ouvrir de porte vers votre réseau interne (SSRF), et tout ce qu'un modèle lit
du web lui est présenté comme des données, pas comme des instructions. Un
navigateur intégré, facultatif et isolé, lit les pages construites en
JavaScript, parcourt les liens d'un site et utilise sa recherche interne.

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
const { createWebSearch, braveProvider, tavilyProvider, formatForModel } = require('@astratra/web-search');

// Les moteurs et leur ordre sont les tiens : le paquet n'en choisit aucun.
const ws = createWebSearch({
  providers: [
    braveProvider({ key: () => process.env.BRAVE_SEARCH_API_KEY }),
    tavilyProvider({ key: () => process.env.TAVILY_API_KEY })
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
| `gatewayProvider({ search })` | une passerelle de recherche à toi : `search({ requete, nombre, langue?, pays?, periode? }, { signal })` rend `{ fournisseur, resultats: [{ titre, url, extrait, date? }] }` | Les clés des moteurs restent chez ta passerelle, qui compte le coût (`costPerCallUsd: null`). Les sites partent en opérateurs `site:`. |
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
- **MCP** : `createMcpServer(ws)` de `@astratra/web-search/mcp` (protocole de
  `@astratra/mcp`, sans dépendance) sert les deux mêmes outils, marqués en lecture
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

## Navigateur intégré (lecture seule)

Une page construite en JavaScript (React, Vue…) ne donne presque rien à la
lecture simple. Le navigateur intégré l'ouvre dans un vrai Chromium sans
fenêtre, attend qu'elle se pose et lit ce qu'une personne voit. Il permet aussi
de **parcourir** un site (liens numérotés), d'utiliser **sa recherche
interne** sans cliquer ni taper, et de prendre une **capture d'écran** sur
demande. Il ne modifie rien sur le web : ni clic qui envoie quelque chose, ni
formulaire autre qu'une recherche en GET, ni connexion, ni achat.

```js
const { createWebSearch, createBrowserClient } = require('@astratra/web-search');

const ws = createWebSearch({
  providers: [/* … */],
  browser: createBrowserClient({ baseUrl: 'http://127.0.0.1:5008', tokenFile: '/etc/astratra/browser-token' })
});

await ws.read(url);                              // lecture simple, puis le navigateur sous 200 mots
const page = await ws.browse(url, { query });    // texte rendu, liens [L1]…, passages
await ws.browse(page.links[0].url);              // suivre un lien
await ws.searchSite('https://docs.python.org/3/', 'asyncio');  // recherche interne du site
await ws.browse(url, { screenshot: true });      // page.screenshot : PNG 1280 × 800 au plus
```

- `reading.browser` : `'fallback'` (défaut avec un navigateur : sous
  `reading.minWords`, 200 mots, la lecture simple passe la main),
  `'always'` ou `'never'`. `page.via` dit qui a lu (`fetch` ou `browser`).
- Deux outils s'ajoutent quand `browser` est donné, dans `toolDefinitions`
  (`{ browser: true }`), `nativeTools`, `registryTools` et le serveur MCP :
  `browse_page` `{ url, query?, quotes?, screenshot? }` et `search_site`
  `{ url, query }`. Mêmes règles que `read_page` : https seulement, texte
  dans le cadre des données non fiables (liens compris), sources
  `kind: 'web'`, risque `LOW`, genre `read`, `external: true`.
- Capture d'écran : seulement pour un modèle qui lit les images
  (`nativeTools(ws, { screenshots: true })` rend `images`, le serveur MCP
  `createMcpServer(ws, { screenshots: true })` un contenu image) ; refusée
  sinon. `registryTools` rend du texte seulement.
- `allowDomains: ['example.com']` (option de `createWebSearch`) limite les
  pages lues et ouvertes à ces sites ; `ranking.blockDomains` est refusé pour
  toutes les lectures (et pour les redirections, dans le navigateur).
- Recherche interne : la description OpenSearch du site, sinon un formulaire
  `GET` à un seul champ texte de recherche ; l'adresse de résultats est
  calculée puis ouverte, sur le même site. Les moteurs de recherche (Google,
  Bing…) sont refusés : ils s'interrogent par leur API, avec `web_search`.

### Le service `astratra-web-browser`

En production, un seul Chromium tourne sur le serveur, partagé par toutes les
applications, dans un service à part livré par le paquet. Il écoute
`127.0.0.1:5008` (jamais l'extérieur), demande un jeton `Authorization:
Bearer` relu dans un fichier à chaque requête, et sert `POST /v1/open`,
`POST /v1/site-search` et `GET /health`. Chaque requête ouvre un contexte neuf
(ni cookies, ni stockage, ni cache), une seule page, détruit à la fin ; deux
pages au plus en même temps (`--max-contexts`), puis une attente bornée, puis
`503 busy`.

Installation sur un serveur Linux (Ubuntu 24, en root) :

```bash
npm install @astratra/web-search playwright
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx playwright install --with-deps chromium-headless-shell
npx astratra-web-browser setup --out ./navigateur --node "$(command -v node)" \
  --token-file /etc/astratra/browser-token --browsers-path /opt/ms-playwright
```

`setup` vérifie d'abord la machine (Linux, systemd, nftables, AppArmor, Node,
Chromium, résolveur DNS) et dit ce qui manque, puis écrit l'unité systemd, les
règles nftables et l'unité qui les charge au démarrage (sans toucher aux autres
règles de la machine), le profil AppArmor et la marche à suivre (`INSTALL.md` en
anglais, `INSTALL.fr.md` en français). Les résolveurs DNS viennent de
`/etc/resolv.conf` (`--dns` pour en donner d'autres).

**Le jeton** est un secret propre à la
machine, qui empêche les autres programmes du serveur d'utiliser le
navigateur. `astratra-web-browser token --out /etc/astratra/browser-token
--group astratra-browser` le tire au hasard (32 octets) et l'écrit à root, en
mode 640, lisible par le groupe `astratra-browser`. On met dans ce groupe
l'utilisateur de chaque application qui appelle le service ; elle le lit avec
`createBrowserClient({ tokenFile })`. Changer le jeton, c'est réécrire le
fichier : le service et les clients le relisent à chaque requête.

Pour le développement, `createLocalBrowser()` fait tourner le même moteur dans
le processus (il faut `playwright`) ; il refuse de démarrer quand
`NODE_ENV=production`, sauf `allowInProduction: true`. Ou bien
`astratra-web-browser serve --token-file … --unsafe-no-firewall` lance le
service sur un poste sans pare-feu.

`createBrowserPm2App` existe aussi, mais pm2 ne donne aucune des protections
de systemd (utilisateur à part, système en lecture seule, mémoire bornée) :
le pare-feu reste obligatoire, et pm2 doit tourner sous l'utilisateur du
service.

### Pour les utilisateurs du framework : quelle installation choisir

Le paquet ne dépend d'aucun service d'Astratra : chacun fait tourner **son**
navigateur, sur **sa** machine, avec **son** jeton.

| Votre hébergement | Ce qu'il faut faire |
|---|---|
| Un serveur Linux à vous (VPS, dédié) avec systemd | Le service `astratra-web-browser`, installé par `setup` : la méthode conseillée, la seule avec toutes les protections. |
| Un serveur Linux sans systemd (pm2 seul) | `createBrowserPm2App`, sous l'utilisateur du service, avec le pare-feu ; moins de protections (ni système en lecture seule, ni mémoire bornée par le noyau). |
| Un hébergement sans accès root ou sans serveur (Vercel, Netlify, fonctions, Render, Heroku), un conteneur | Pas de navigateur en production pour l'instant : la recherche et `read_page` marchent sans lui. Le mode local ne remplace pas le service. |
| Un poste de développement (macOS, Windows, Linux) | `createLocalBrowser()`. |

- **Mettez votre propre identité.** Par défaut, tous les déploiements se
  présentent comme `AstratraWebBrowser` avec la page GitHub du paquet : donnez
  votre page avec `--info-url` (qui vous êtes, comment vous joindre), et, pour
  signer vos requêtes, votre propre clé publiée sur votre domaine
  (`keygen`, `--signing-key-file`, `--signature-agent`). Un site qui bloque le
  nom `AstratraWebBrowser` dans son `robots.txt` est refusé pour tous.
- **Seul Ubuntu 24.04 a été essayé** de bout en bout (pare-feu, AppArmor,
  cloisonnement). Debian 12 et Ubuntu 22.04 devraient convenir ; `setup` dit
  ce qui manque.
- Vous répondez de votre usage : conditions des sites lus, `robots.txt` (le
  paquet le respecte, ne le désactivez pas sans droit), données personnelles
  des pages.

### Isolement

Chaque protection tient si une autre cède :

- **Utilisateur et processus** : utilisateur système `navigateur`, unité
  systemd durcie (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
  `NoNewPrivileges`, `MemoryMax=2G`, `CPUQuota=200%`, jeton par
  `LoadCredential`, seuls les espaces de noms dont Chromium a besoin). Le
  service refuse de tourner en root.
- **Cloisonnement de Chromium** actif : un lancement sans lui est refusé
  (`--no-sandbox` interdit). Sur Ubuntu 23.10 et suivants, le profil AppArmor
  de `setup` lui permet de créer ses espaces de noms.
- **Relais de sortie** : Chromium n'ouvre aucune connexion lui-même, tout
  passe par un relais du service (boucle locale comprise). Le relais résout
  chaque nom, refuse toute adresse non publique (mêmes plages que
  `isPublicAddress`) et se connecte à l'adresse vérifiée : redirections,
  WebSocket, images, `fetch` des scripts et DNS rebinding sont couverts.
  WebRTC est coupé.
- **Pare-feu système, obligatoire** : les règles nftables refusent à
  l'utilisateur `navigateur` toute sortie vers une adresse non publique, sauf
  le résolveur DNS et le relais.
- **Contrôle au démarrage** : le service tente de joindre la boucle locale,
  une adresse privée de la machine et `169.254.169.254` ; si l'une répond, il
  refuse de démarrer (`isolation_failed`). `/health` donne le résultat.
- **Page** : ni téléchargement, ni `file://`, ni service worker, ni
  permission, ni fenêtre surgissante (fermée), ni boîte de dialogue (refusée).
  15 s par page, 25 s par requête, 5 redirections, 10 Mo de ressources (les
  requêtes suivantes sont coupées), 2 Mo de texte.

### Ce que lit le modèle

Le texte **visible** seulement : les éléments cachés (`display`,
`visibility`, `opacity`, hors de l'écran, d'un pixel, découpés, police nulle,
couleur transparente ou égale au fond, `aria-hidden`) sont retirés avant la
lecture, car un texte caché est l'arme classique pour glisser un ordre à une
IA. Les bandeaux de cookies, fenêtres d'abonnement et boîtes modales sont
masqués **sans cliquer**. Les liens (https, 50 au plus, ceux du même site
d'abord) sont numérotés dans le cadre.

Ces protections sont pour l'IA ce que l'isolement est pour le serveur : à
passer aussi par les gardes de `@astratra/ai`, qui cherchent les injections
de consignes avec le modèle de garde de `@astratra/models` et refusent toute
action après un soupçon :

```js
const { createGuards } = require('@astratra/ai/guards');
const guards = createGuards({ models });          // client de @astratra/models
const run = guards.newRun({ mode: 'action' });
const browse = nativeTools(ws).find((tool) => tool.name === 'browse_page');
const { data } = await browse.run({ url });
const checked = await guards.toolResult(data, run, { tool: 'browse_page', external: true });
// checked.suspected → plus aucune action sans l'accord d'une personne :
await guards.beforeAction({ name: 'send_email' }, run);   // { decision: 'block', reason: 'confirmation_required' }
```

### Identité de l'agent

- `User-Agent` honnête : `Mozilla/5.0 (compatible; AstratraWebBrowser/<version>; +<infoUrl>)`.
  `--info-url` donne la page qui explique l'agent (par défaut, la page GitHub
  du paquet). Aucune imitation d'un humain, aucun module « furtif » : un site
  qui refuse les agents est refusé.
- `robots.txt` est respecté pour chaque page ouverte par le navigateur (jeton
  `AstratraWebBrowser`, sinon `*`, cache d'une heure ; un `robots.txt` en
  panne vaut refus) : une page interdite rend `WEB_BROWSE_ROBOTS_DISALLOWED`.
  La cible d'une redirection est vérifiée à l'arrivée : la requête est partie,
  mais la page n'est pas rendue.
- **Web Bot Auth** (facultatif) : `astratra-web-browser keygen --out cle.pem
  --directory annuaire.json` crée une clé Ed25519 et l'annuaire à publier à
  `/.well-known/http-message-signatures-directory` de votre domaine ; avec
  `--signing-key-file` et `--signature-agent https://votre-domaine`, chaque
  requête est signée (RFC 9421 : `Signature`, `Signature-Input`,
  `Signature-Agent`).

### Erreurs

| Code | Quand |
|---|---|
| `WEB_BROWSE_ROBOTS_DISALLOWED` | `robots.txt` interdit la page (ou la cible d'une redirection) |
| `WEB_READ_BLOCKED_ADDRESS` | la page ou une redirection vise une adresse non publique |
| `WEB_READ_BLOCKED_DOMAIN` | site bloqué (`blockDomains`) ou hors de `allowDomains` |
| `WEB_BROWSE_NO_SITE_SEARCH` | ni OpenSearch ni formulaire GET de recherche |
| `WEB_BROWSE_REFUSED` | page de recherche d'un moteur (utiliser `web_search`) |
| `WEB_BROWSE_BUSY` | le service est plein ; réessayer |
| `WEB_BROWSE_TIMEOUT` | la page a dépassé son délai |
| `WEB_BROWSER_UNAVAILABLE` | service arrêté, disjoncteur ouvert, ou `browser` absent |
| `WEB_READ_BAD_STATUS`, `WEB_READ_UNSUPPORTED_TYPE`, `WEB_READ_TOO_MANY_REDIRECTS`, `WEB_BROWSE_FAILED` | comme pour `read_page` |

Le client ne lève jamais : `open` et `siteSearch` rendent `{ ok: true,
result }` (`result.status` : `ok`, `robots_disallowed`, `blocked`…) ou
`{ ok: false, code, retryable }`. Délai de 30 s, nouvel essai sur panne réseau
ou service plein, disjoncteur (trois pannes de suite : 30 s de refus rapides).

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
- Sans navigateur intégré, il n'exécute pas le JavaScript des pages : une page
  entièrement construite dans le navigateur donne peu de texte (voir
  [Navigateur intégré](#navigateur-intégré-lecture-seule)).
- Le navigateur intégré ne fait que lire : il ne clique pas, ne remplit aucun
  formulaire (sauf une recherche en GET, par son adresse), ne se connecte pas,
  n'achète rien. Ni JSON ni PDF.
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
que le vrai. Les tests du navigateur tournent sur un vrai Chromium contre un
petit site HTTPS local de pages pièges (texte caché, redirections et
WebSocket vers l'intérieur, téléchargement, page énorme…) ; ils sont sautés
sans Playwright ni Chromium.
