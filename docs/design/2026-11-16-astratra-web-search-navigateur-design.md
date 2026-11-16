# @astratra/web-search — navigateur intégré : conception

Date : 2026-11-16
État : conception validée le 16 novembre 2026 (réponses dans « Décisions »). **Premier étage construit et vérifié** (`@astratra/web-search` 1.2.0, non publié) ; plan : `docs/plans/2026-11-16-astratra-web-search-navigateur-plan.md` ; écarts et vérifications : « Construction du premier étage » en fin de document. Étages 2 et 3 non construits.

## Pourquoi

`@astratra/web-search` donne aux IA deux outils, `web_search` et
`read_page`, servis aux formats Anthropic, OpenAI, Mistral et Gemini et par son
serveur MCP. Toute IA qui a le pack les reçoit sans rien recoder.

Il lit les pages sans exécuter de JavaScript. Son README le dit : une page
construite dans le navigateur (React, Vue…) donne presque rien. Une IA ne peut
pas non plus parcourir un site : suivre ses liens, utiliser sa recherche
interne, voir la page telle qu'une personne la voit.

Ce chantier ajoute au pack un **navigateur intégré** : un Chromium sans
fenêtre, installé sur le VPS, que toutes les IA qui ont le pack peuvent
utiliser. Les recherches par moteurs restent telles quelles.

Contexte du moment (novembre 2026) : les agents qui naviguent doivent de plus
en plus prouver leur identité (Web Bot Auth de Cloudflare, Trusted Agent
Protocol de Visa) ; les achats par agents passent par des jetons, jamais par
la carte en clair. Ce chantier prépare la place de l'achat sans le construire.

## Trois étages

1. **Lire et parcourir (ce chantier).** Pages en JavaScript, liens d'un site,
   recherche interne d'un site, capture d'écran sur demande. L'IA ne modifie
   rien sur le web.
2. **Agir (plus tard).** Remplir un formulaire, se connecter. Chaque action
   attend l'accord d'une personne ; les mots de passe ne passent jamais par
   l'IA.
3. **Acheter (encore après).** Seulement par jeton (réseaux de cartes, Stripe,
   AP2), avec l'accord de la personne (passkey en Europe) et un plafond. Sans
   carte, rien ne part.

Les étages 2 et 3 ne sont pas construits ici. L'architecture ci-dessous leur
laisse leur place sans rien défaire (voir « Plus tard »).

## Buts

- Lire une page après exécution de son JavaScript, avec les garanties
  actuelles du pack : texte cadré comme donnée non fiable, passages cités mot
  pour mot avec leur position, sources.
- Parcourir : la page rend ses liens, numérotés ; l'IA peut ouvrir l'un d'eux.
- Recherche interne d'un site, sans cliquer ni taper : par la description
  OpenSearch du site, ou par son formulaire de recherche en GET.
- Capture d'écran, seulement si on la demande.
- Un seul navigateur partagé sur le VPS, isolé, que plusieurs applications
  utilisent.
- `read_page` et `search({ read })` passent par le navigateur quand la lecture
  simple ne donne presque rien (pages en JavaScript).

## Non-buts (ce chantier)

- Cliquer sur un bouton qui envoie quelque chose, remplir un formulaire autre
  qu'une recherche en GET, se connecter, acheter, publier.
- Lire les PDF et les images (inchangé).
- Remplacer les moteurs de recherche : la recherche reste aux API (Serper, Brave, Tavily, Exa).

## Anti-buts (échec même si « ça marche »)

- Le navigateur atteint le réseau interne du VPS (base de données, autres
  services, `models`, métadonnées du cloud).
- Le navigateur contourne une protection : CAPTCHA, blocage d'agents,
  imitation d'un humain (aucun module « furtif »). Un site qui refuse les
  agents est refusé.
- Remplir la page de recherche de Google ou d'un autre moteur à la place de
  son API.
- Une page lue donne un ordre que l'IA exécute.
- Un compte, un cookie ou une donnée d'une application passe d'une recherche à
  l'autre.

## Approches considérées

| | Approche | Pour | Contre |
|---|---|---|---|
| A | Un Chromium dans chaque application (comme `@astratra/prerender`) | Rien à installer à part | Un Chromium par application (mémoire), page piégée dans le processus de l'application |
| **B** | **Un service navigateur partagé sur le VPS, livré par le pack** | Un seul Chromium, mémoire bornée, processus et utilisateur à part, réseau fermé vers l'intérieur, une seule identité d'agent | Plus de travail que A |

**Choix retenu : B**, isolé.
En développement et dans les tests, le même moteur tourne
dans le processus (comme A).

## Architecture

### 1. Le service `astratra-web-browser`

Une nouvelle commande du pack (`bin`), qui tourne sur le VPS :

- Node, Playwright et Chromium sans fenêtre (`chromium-headless-shell`).
  `playwright` devient une **dépendance d'appairage facultative** de
  `@astratra/web-search` (comme dans `@astratra/prerender`) : une application
  qui n'utilise que le client ne l'installe pas.
- Écoute `127.0.0.1` (port 5008 par défaut), jamais l'extérieur. Jeton
  `Authorization: Bearer`, lu dans un fichier (`tokenFile`) à chaque requête,
  comme le service `@astratra/models`.
- Points d'entrée :
  - `POST /v1/open` `{ url, screenshot?, waitFor? }` → `{ status, finalUrl,
    title, text, links: [{ n, url, text }], canonical, publishedAt, truncated,
    screenshot? }` ;
  - `POST /v1/site-search` `{ url, query }` → la page de résultats, même
    forme ;
  - `GET /health` → version, Chromium, contrôles d'isolement, pages en cours.
- Chaque requête ouvre un **contexte neuf** (ni cookies, ni stockage, ni
  cache), une seule page, détruit à la fin.
- File d'attente bornée : `maxContexts` (2 par défaut) en parallèle ; au-delà,
  attente au plus `queueMs`, puis `503 busy`.
- `text` : seulement le texte visible (éléments cachés, transparents, hors de
  l'écran ou de taille nulle retirés) ; les surcouches fixes (bandeaux de
  cookies, fenêtres d'abonnement) sont masquées avant la lecture, **sans
  cliquer**.
- `links` : liens `https` du même site d'abord, puis les autres ; 50 au plus.
- Recherche interne : `<link rel="search" type="application/opensearchdescription+xml">`
  du site (modèle d'adresse `{searchTerms}`), sinon un formulaire `GET` qui
  n'a qu'un champ texte (`type="search"` ou `role="search"`). L'adresse de
  résultats est calculée puis ouverte comme une page : aucune frappe, aucun
  clic. Sans l'un ou l'autre : `{ status: 'no_site_search' }`.

### 2. Le client, dans le pack

`createBrowserClient({ baseUrl, token })` : appelle le service, sans
dépendance. Délais, nouvel essai sur panne réseau, disjoncteur, résultats qui
se dégradent au lieu de lever, comme le client de `@astratra/models`.

`createLocalBrowser()` : le même moteur dans le processus, pour le
développement et les tests (Playwright requis).

### 3. Ce que voient les IA

- `createWebSearch({ providers, browser })` : `browser` est un client (ou un
  moteur local).
- `read_page` et `search({ read })` : `reading.browser: 'fallback'` (par
  défaut quand `browser` est donné) passe par le navigateur quand la lecture
  simple donne moins de `reading.minWords` (200) mots visibles ; `'always'` et
  `'never'` existent aussi.
- Deux nouveaux outils, dans `toolDefinitions`, `nativeTools`,
  `registryTools` et le serveur MCP, présents seulement quand `browser` est
  donné :
  - `browse_page` `{ url, screenshot? }` : la page rendue, cadrée comme
    `read_page`, et ses liens numérotés ;
  - `search_site` `{ url, query }` : la recherche interne d'un site.
- Mêmes règles que `read_page` : `https` seulement, sites bloqués de
  `ranking.blockDomains` refusés, texte cadré dans le cadre de données non
  fiables, sources `kind: 'web'` (ce qui marque l'exécution comme exposée pour
  `readsUntrusted`), risque `LOW`, genre `read`, `external: true`.
- La capture d'écran rend une image PNG de 1280 × 800 au plus, ajoutée au
  résultat de l'outil pour les modèles qui lisent les images ; refusée pour les
  autres.

### 4. Gardes

Les pages lues par le navigateur passent par `guards.toolResult(page, run, {
tool, external: true })` de `@astratra/ai/guards`, comme les pages lues
aujourd'hui : détection d'injection de consignes par le service
`@astratra/models` (par morceaux), cadre de données non fiables, puis
`beforeAction` refuse toute action après un soupçon. Le README le montre.

Ces gardes protègent l'IA ; elles ne protègent pas le serveur. L'isolement
ci-dessous protège le serveur.

### 5. Isolement

Chaque protection doit tenir si une autre cède.

**Processus et utilisateur**
- Le service tourne sous un utilisateur système à part (`navigateur`), dans
  une unité systemd durcie fournie par le pack (`createBrowserSystemdUnit`,
  sur le modèle de `createSystemdUnit` de `@astratra/models`) :
  `MemoryMax`, `CPUQuota`, `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, `PrivateTmp`, jeton par `LoadCredential`. Une entrée pm2
  existe aussi (`createBrowserPm2App`), sans les protections de systemd ; le
  README le dit.
- Le cloisonnement de Chromium (sandbox) reste actif : `--no-sandbox` est
  refusé. Au démarrage, le service vérifie que le cloisonnement fonctionne et
  refuse de démarrer sinon (sur Ubuntu 24, il peut demander un profil
  AppArmor : la commande de préparation l'écrit).

**Réseau**
- Pare-feu système, **obligatoire en production** : le pack génère les règles
  nftables qui refusent à l'utilisateur `navigateur` toute sortie vers les
  adresses non publiques (mêmes plages que `isPublicAddress` : boucle locale,
  réseaux privés, lien local dont 169.254.169.254, CGNAT, ULA…), sauf le
  résolveur DNS. C'est la seule protection qui couvre tout (WebRTC, DNS
  rebinding, WebSocket).
- Dans le navigateur, en plus : chaque requête de la page est interceptée
  (`route`) ; seules `https` (et `http` vers un site public si
  `allowHttp`) passent ; le nom est résolu et refusé si une de ses adresses
  n'est pas publique. WebRTC est coupé
  (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`).
- **Contrôle au démarrage** : le service tente de joindre `127.0.0.1` (son
  propre port), une adresse privée et `169.254.169.254`. Si l'une répond, il
  refuse de démarrer (`isolation_failed`). `/health` donne le résultat.
  Production sans pare-feu = refus de démarrer, sauf `--unsafe-no-firewall`
  explicite pour le développement.

**Page**
- Ni téléchargement, ni `file://`, ni `chrome://`, ni extensions, ni
  service workers ; permissions refusées (position, caméra, micro,
  notifications) ; fenêtres surgissantes fermées ; boîtes de dialogue
  refusées.
- Limites : 15 s par page, 25 s par requête, 5 redirections, 10 Mo de
  ressources par page (au-delà, les requêtes suivantes sont coupées), 2 Mo de
  texte, 1 page par contexte.
- Chromium tenu à jour : version de Playwright épinglée, mise à jour mensuelle
  notée dans `docs/PUBLISHING.md`.

### 6. Identité de l'agent

- `User-Agent` honnête : `Mozilla/5.0 (compatible; AstratraWebBrowser/<version>; +<infoUrl>)`,
  `infoUrl` donnée par le déploiement (une page qui explique l'agent).
- **Web Bot Auth**, facultatif : avec une clé Ed25519 (`signingKeyFile`) et
  l'adresse publique de l'annuaire de clés (`signatureAgent`), chaque requête
  partant de la page est signée (en-têtes `Signature`, `Signature-Input`,
  `Signature-Agent`, RFC 9421). Le pack fournit la commande qui crée la clé et
  le fichier JSON de l'annuaire à publier à
  `/.well-known/http-message-signatures-directory` du domaine choisi.
- `robots.txt` : respecté pour chaque page ouverte par le navigateur (jeton
  `AstratraWebBrowser`, cache d'une heure). Une page interdite rend
  `{ status: 'robots_disallowed' }`.

## Plus tard (non construit)

- **Étage 2** : un point d'entrée `/v1/act` à part, désactivé par défaut, qui
  exigera un jeton d'approbation émis après l'accord d'une personne
  (`beforeAction`), et des sessions avec identité gardées dans un coffre. Rien
  de l'étage 1 n'est réutilisé pour agir.
- **Étage 3** : achat par jeton (Stripe Shared Payment Tokens, AP2), plafond,
  passkey. Jamais de carte dans le pack ni dans ce que lit l'IA.

## Vérification

- Tests sans réseau (comme aujourd'hui) : client, outils, cadre, repli de
  `read_page`, générateurs systemd, pm2 et nftables, contrat client ↔ service.
- Tests sur vrai Chromium (sautés sans Playwright, comme `prerender`), sur un
  petit site local de pages pièges : page construite en JavaScript, bandeau de
  cookies, texte caché qui donne un ordre, redirection vers une adresse
  interne, WebSocket vers `127.0.0.1`, page énorme, fenêtre surgissante,
  téléchargement forcé, recherche OpenSearch et formulaire GET.
- Sur Linux, pour de vrai : le service installé avec son unité systemd et son
  pare-feu, le contrôle de démarrage qui refuse sans pare-feu, et une
  tentative d'atteindre 169.254.169.254 et un service local qui échoue.
- Une IA réelle, branchée par `nativeTools` et les gardes, lit une page en
  JavaScript, suit un lien et cite ses passages.

## Décisions (16 novembre 2026)

Les quatre questions ouvertes ont été tranchées :

1. **Jusqu'où l'IA peut naviguer : toutes les pages publiques** en `https`,
   comme `read_page`, les liens du même site montrés d'abord. Un réglage
   facultatif `allowDomains` permet à une application de restreindre ses IA à
   une liste de sites ; sans lui, l'exploration est libre.
2. **`robots.txt` est respecté** pour chaque page ouverte par le navigateur
   (jeton `AstratraWebBrowser`, sinon `*`, cache d'une heure). Une page
   interdite rend `{ status: 'robots_disallowed' }`. La lecture simple
   (`read_page` sans navigateur) reste inchangée.
3. **Essai Linux sur Colima** (déjà installé sur le Mac), dans une machine
   Ubuntu à part dont les fichiers restent sur le SSD ; pas le VPS de
   production. Le système exact du VPS reste à confirmer : le profil AppArmor
   est écrit pour Ubuntu 24 et sans effet ailleurs.
4. **Identité de l'agent** : la signature Web Bot Auth est construite mais
   désactivée par défaut ; `infoUrl` pointe par défaut vers la page GitHub du
   pack (`https://github.com/emch04/astratra/tree/main/packages/web-search`)
   tant qu'aucun domaine n'est choisi.

Les « Choix de conception de Claude » ci-dessous ont aussi été validés tels quels.

## Choix de conception de Claude (validés)

Faits sans demander, modifiables : port 5008 ; 2 pages en parallèle
(`maxContexts`), attente bornée puis `503 busy` ; 15 s par page, 25 s par
requête, 5 redirections, 10 Mo de ressources et 2 Mo de texte par page ;
repli du navigateur sous 200 mots visibles (`reading.minWords`) ; 50 liens au
plus, ceux du même site d'abord ; capture de 1280 × 800 au plus, seulement sur
demande ; surcouches masquées sans clic plutôt que bandeaux refusés par clic ;
recherche interne seulement par OpenSearch ou formulaire GET à un champ ;
`playwright` en dépendance d'appairage facultative ; contrôle d'isolement au
démarrage qui refuse de démarrer, sauf `--unsafe-no-firewall` en
développement.

## Laissé au développeur

Les noms internes, le découpage des fichiers, l'heuristique exacte du texte
visible, le format des messages d'erreur (codes comme le reste du pack), et
la répartition des tests, en restant dans les règles ci-dessus.

## Construction du premier étage (16 novembre 2026)

Construit comme ci-dessus, avec ces écarts, découverts en construisant :

- **Relais de sortie dans le service.** L'interception de Playwright
  (`route`) ne voit pas les redirections : un premier essai sur vrai Chromium
  a montré qu'une page redirigée vers `127.0.0.1` l'atteignait. Chromium
  passe donc par un relais (`--proxy-server`, boucle locale comprise) qui
  résout chaque nom lui-même, refuse toute adresse non publique et se
  connecte à l'adresse vérifiée. Il couvre aussi les WebSocket et le DNS
  rebinding, que le document confiait au seul pare-feu. Le relais écoute sur
  `127.0.0.1:5009` avec un identifiant tiré au hasard ; le pare-feu permet à
  l'utilisateur `navigateur` ce seul port local, en plus du résolveur DNS.
- **robots.txt et redirections.** La page ouverte est vérifiée avant de
  partir ; la cible d'une redirection, à l'arrivée (la requête est partie,
  mais la page n'est pas rendue). Un `robots.txt` en panne (5xx, 429, réseau)
  vaut refus, comme le dit la RFC 9309.
- **Masquage.** En plus des surcouches fixes : les bandeaux de consentement
  non fixes nommés comme tels (Orejime, Didomi, OneTrust…) quand ils proposent
  un bouton, et les boîtes `<dialog>` ouvertes. Une section qui parle des
  cookies sans proposer de choix reste.
- **Description OpenSearch** lue par un `fetch` de la page (même contrôle que
  ses autres requêtes) : ouverte comme une page, elle serait un téléchargement.
- **`blockDomains`** s'applique désormais aussi à `read_page`
  (`WEB_READ_BLOCKED_DOMAIN`), et `allowDomains` est une option de
  `createWebSearch`.
- **Contrôle au démarrage** : sur Linux, une connexion TCP jetée en sortie par
  nftables attend son délai (1,5 s) au lieu d'échouer tout de suite ; le
  résultat est le même (« timeout », pas « reached »).

Vérifié :

- 255 tests du paquet sur le Mac (254 dans une machine Ubuntu 24.04 sous Colima, avant l'ajout du test de signature),
  dont 27 sur vrai Chromium contre un site local de pages pièges : rien
  n'atteint le serveur interne (redirection vers une IP ou un nom privé,
  navigation en JavaScript, image, `fetch`, balise, WebSocket), texte caché
  retiré, bandeaux masqués, robots.txt, téléchargement, page énorme, budget de
  ressources, OpenSearch et formulaire, signature Web Bot Auth vérifiée.
- Lint, types (`typecheck.ts`), archive npm (ni test, ni clé).
- Sur le Mac, service réel (`--unsafe-no-firewall`) : excalidraw.com (0 mot en
  lecture simple, 73 avec le navigateur), recherche interne de
  docs.python.org (OpenSearch), de packaging.python.org et service-public.fr
  (formulaire), lien suivi, capture ; refus de robots.txt sur les pages de
  recherche de MDN, Wikipédia et Google ; refus de démarrer sans pare-feu.
- Sur Ubuntu 24.04 (Colima), installé comme en production (utilisateur
  `navigateur`, unité systemd, nftables, AppArmor) : refus de démarrer sans
  pare-feu ; avec pare-feu, « isolation ok » ; cloisonnement de Chromium actif
  (aucun `--no-sandbox`, espaces de noms séparés, seccomp) ; l'utilisateur
  `navigateur` ne joint ni la boucle locale, ni l'adresse privée, ni
  169.254.169.254, ni Docker, ni `[::1]`, mais joint le web public ;
  redirections publiques vers `127.0.0.1`, `169.254.169.254` et un nom qui
  résout en `127.0.0.1` refusées par le relais, aucune requête reçue par le
  serveur interne.

Non vérifié : le VPS lui-même (rien n'y est installé) ; une IA réelle branchée
de bout en bout (les outils et les gardes sont vérifiés avec un modèle simulé
et un modèle de garde simulé) ; l'entrée pm2 ; la signature Web Bot Auth
auprès d'un vrai vérificateur (Cloudflare) : l'annuaire n'est publié nulle
part.
