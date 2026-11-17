# @astratra/wallet : billets, cartes d'embarquement et clés futures d'Apple

État : décidé le 17 novembre 2026 ; construit dans la foulée, avant la publication de la 1.2.0.

## Pourquoi

La 1.2.0 ne savait écrire que les cinq zones de champs d'une carte. Un vrai billet de spectacle a besoin de plus :

- la zone d'informations (`additionalInfoFields`) ;
- la date de la séance, pour que le billet remonte sur l'écran verrouillé ;
- le lieu ;
- les billets d'une même commande rangés ensemble ;
- les étiquettes sémantiques du billet en affiche ;
- plusieurs codes-barres.

Sans ces éléments, chaque nouveau client obligeait à revenir modifier le paquet. Le but est de pouvoir faire un billet sans y toucher.

## Buts

- Tout ce que la documentation d'Apple (WalletPasses, « Pass ») décrit pour un billet, une carte d'embarquement ou une carte en affiche se donne au paquet, sans le modifier.
- Une clé qu'Apple ajoutera plus tard passe aussi, par une porte de sortie (`extraKeys`).
- Chaque clé connue est contrôlée comme les autres : une date sans fuseau, un lieu mal écrit ou un lien qui n'est pas en http(s) sont refusés avec un message clair.
- Rien ne change pour les cartes existantes : une carte qui n'utilise rien de nouveau produit le même `pass.json`, octet pour octet (vérifié sur les quatre cartes d'une application cliente).

## Non-buts

- Valider le contenu des étiquettes sémantiques une par une. Apple en définit plusieurs dizaines et en ajoute à chaque version d'iOS. Le paquet vérifie que c'est un objet, convertit les dates en texte et refuse ce qui ne s'écrit pas en JSON.
- Les « actions mises en avant » d'iOS 27. Leur format JSON n'est pas encore publié dans la documentation : elles passent par `extraKeys`.
- Le contenu des billets Google. Comme pour la fidélité, il suit l'API de Google Wallet, et le paquet le transmet tel quel.

## Approches

1. **Les clés connues, nommées et contrôlées, plus une porte de sortie (choisie).** Chaque clé documentée a son contrôle (date, lien, couleur, liste, objet aux clés connues). `extraKeys` écrit le reste tel quel, mais ne peut ni remplacer une clé que le paquet écrit (identité, style, jeton), ni contourner une clé qui a son contrôle.
2. **Tout laisser passer sans contrôle.** C'est simple, mais une faute de frappe donnerait une carte qu'Apple refuse sans rien dire, ce que la 1.2.0 cherche justement à éviter. Refusée.
3. **Ajouter seulement `additionalInfoFields`.** Cela ne règle pas le problème : le billet suivant demanderait encore une modification. Refusée.

## Ce qui est construit

- `src/pkpass/options.js` : la liste des clés de premier niveau et leurs contrôles, `extraKeys`, et la conversion des `Date` en ISO 8601.
- `src/pkpass/pkpass.js` :
  - la zone d'informations, écrite seulement si elle est remplie ;
  - `boardingPass` et son `transitType` ;
  - `posterGeneric`, écrit à côté du style classique ;
  - `barcodes` et les huit formats ;
  - les clés uniques par style.
- `src/apple.js` :
  - chaque clé se donne à la fabrique, pour toutes les cartes, ou à la carte, qui la remplace ;
  - `extraKeys` se fusionne de la fabrique à la carte ;
  - `description`, `logoText` et `colors` peuvent être propres à une carte.
- `src/google.js` : `eventTicket`, `flight` et `transit`.

## Choix de Claude

- **Une clé inconnue dans une carte reste ignorée**, comme avant. La refuser casserait les applications qui passent leur propre objet à `build`. En revanche, une clé mal écrite à l'intérieur d'un lieu, d'une plage de dates ou d'une balise est refusée.
- **Un format de code-barres d'iOS 27 doit être suivi d'un format classique.** Sans cela, le billet n'aurait aucun code sur un iPhone plus ancien, et il ne pourrait pas entrer.
- **Les clés de champ sont uniques par style.** `posterGeneric` reprend les clés du style classique, comme dans l'exemple d'Apple.
- **`preferredStyleSchemes` accepte n'importe quel texte**, pour ne pas bloquer un style qu'Apple ajouterait.
- **`footerFields` n'est accepté que dans `posterGeneric`.** La page d'Apple sur la carte en affiche le cite, mais la page des zones (PassFields) ne le liste pas encore.

## Vérification

- Les tests de `__tests__/billets.test.js` couvrent :
  - un billet complet ;
  - les réglages communs et ceux de chaque carte ;
  - les codes-barres ;
  - les cartes d'embarquement ;
  - la carte en affiche ;
  - chaque refus ;
  - `extraKeys` ;
  - les billets Google.
- Quatre défauts introduits exprès ont chacun été détectés par ces tests.
- Les quatre cartes d'une application cliente, fabriquées avant et après le changement, ont un `pass.json`, des images et un manifeste identiques, et openssl accepte leur signature. Un billet complet est accepté aussi.
- Reste à faire avant la publication : ajouter un vrai billet sur un iPhone avec le certificat de production.
