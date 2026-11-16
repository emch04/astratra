# @astratra/web-search — navigateur intégré, premier étage : plan d'implémentation

Date : 2026-11-16
Conception : `docs/design/2026-11-16-astratra-web-search-navigateur-design.md`
Portée : premier étage seulement (lecture seule). Agir et acheter ne sont pas construits.

## Fichiers

Tout le nouveau code est dans `packages/web-search/src/browser/` :

| Fichier | Rôle |
|---|---|
| `robots.js` | Lecture de `robots.txt` (RFC 9309) : groupes, `Allow`/`Disallow`, `*` et `$`, règle la plus longue ; cache d'une heure ; pas de réseau (la lecture est injectée). |
| `siteSearch.js` | Fonctions pures : adresse de résultats tirée d'une description OpenSearch (`{searchTerms}`) ou d'un formulaire GET à un seul champ texte ; refus des moteurs de recherche. |
| `pageScript.js` | Le script exécuté dans la page : masque les surcouches fixes sans cliquer, retire le texte caché, rend le texte visible, les liens, les liens OpenSearch et les formulaires de recherche. |
| `guard.js` | Le contrôle de chaque requête de la page : protocole, port, nom, adresses résolues (mêmes plages que `isPublicAddress`), budget d'octets, nombre de navigations. |
| `webBotAuth.js` | Clé Ed25519, empreinte JWK, annuaire de clés, signature RFC 9421 (`Signature`, `Signature-Input`, `Signature-Agent`). |
| `engine.js` | Le moteur Playwright : un Chromium (cloisonnement actif, `--no-sandbox` refusé), un contexte neuf par requête, interception, WebSocket, limites, `robots.txt`, capture. `open()`, `siteSearch()`, `health()`, `close()`. |
| `isolation.js` | Contrôle au démarrage : sondes vers la boucle locale (port du service), une adresse privée et 169.254.169.254, en tant que l'utilisateur du service. |
| `service.js` | Le serveur HTTP (`127.0.0.1:5008`) : jeton relu dans un fichier à chaque requête, file bornée (`maxContexts`, `queueMs`, `503 busy`), `POST /v1/open`, `POST /v1/site-search`, `GET /health`. |
| `client.js` | `createBrowserClient` (sans dépendance : délais, nouvel essai, disjoncteur, jamais d'exception) et `createLocalBrowser` (le moteur dans le processus). |
| `deploy.js` | `createBrowserSystemdUnit`, `createBrowserPm2App`, `createBrowserFirewall` (nftables), `createBrowserAppArmorProfile`, `browserSetupFiles`. Fonctions pures. |
| `cli.js` | La commande `astratra-web-browser` : `serve`, `setup`, `keygen`. |

Modifiés : `webSearch.js` (`browser`, `reading.browser`, `reading.minWords`,
`allowDomains`, `browse()`, `searchSite()`, `blockDomains` appliqué aux
lectures), `tools.js` (`browse_page`, `search_site`, captures), `format.js`
(`formatBrowsedForModel`), `mcp.js`, `mcpStdio.js`, `errors.js` (codes
`WEB_BROWSE_*`), `index.js`, `index.d.ts`, `typecheck.ts`, `package.json`
(`bin`, `playwright` en dépendance d'appairage facultative), README français
et anglais, `docs/PUBLISHING.md` (mise à jour mensuelle de Chromium),
CHANGELOG.

## Étapes

1. `robots.js`, `siteSearch.js`, `webBotAuth.js`, `guard.js` et leurs tests
   (fonctions pures, sans réseau).
2. `pageScript.js` et `engine.js`, testés sur vrai Chromium contre un petit
   site local en HTTPS (certificat créé par `openssl` pendant le test, noms
   `*.example` dirigés vers 127.0.0.1 par `--host-resolver-rules`, résolveur
   du contrôle injecté). Pages pièges : page construite en JavaScript, bandeau
   de cookies, texte caché qui donne un ordre, redirection vers une adresse
   interne (IP et nom qui résout en privé), redirection en JavaScript,
   WebSocket vers 127.0.0.1, page énorme, fenêtre surgissante, téléchargement
   forcé, `robots.txt` qui interdit, recherche OpenSearch et formulaire GET.
   Chaque test négatif vérifie aussi que le serveur interne n'a reçu aucune
   requête. Ces tests sont sautés sans Playwright ou sans Chromium.
3. `isolation.js`, `service.js`, `client.js` : tests du service avec un moteur
   simulé (jeton, entrées refusées, file pleine, santé, taille du corps,
   contrôle d'isolement refusé) et contrat client ↔ service sur un vrai port.
4. `deploy.js` et `cli.js` : tests des fichiers générés (aucune valeur
   secrète, échappement, durcissement systemd compatible avec le cloisonnement
   de Chromium : espaces de noms `user pid net` permis).
5. Branchement : `createWebSearch({ browser })`, repli de `read()` sous
   200 mots, `browse()`, `searchSite()`, outils, MCP. Tests avec un navigateur
   simulé : outils présents seulement avec `browser`, sites bloqués, liens
   renumérotés, captures rendues seulement si permises, texte cadré.
6. Vérification : tests du paquet, lint, types, `npm pack --dry-run`, essai
   réel du service sur le Mac (`--unsafe-no-firewall`) sur une page publique
   qui demande JavaScript ; puis sur Colima (Ubuntu) : unité systemd, pare-feu
   nftables, profil AppArmor, cloisonnement de Chromium, refus de démarrer
   sans pare-feu, échec des tentatives vers 169.254.169.254 et un service
   local.
7. Documents : README (français et anglais), conception (état), CHANGELOG,
   PUBLISHING ; fusion dans `main` en local, sans pousser ni publier.

## Règles tenues dans le code

- Aucune requête de la page vers une adresse non publique, même par
  redirection, navigation en JavaScript ou WebSocket ; le pare-feu système
  reste la seule protection complète (DNS rebinding, WebRTC), et le service
  refuse de démarrer s'il peut joindre l'intérieur.
- Ni clic, ni frappe : la recherche interne calcule une adresse puis l'ouvre.
- Contexte neuf par requête, détruit à la fin.
- Le jeton du service et la clé de signature ne passent jamais par un fichier
  généré ni par une variable d'environnement écrite dans l'unité.
