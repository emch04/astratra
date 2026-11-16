# @astratra/wallet : fabriquer les cartes Apple Wallet sans passkit-generator

État : décidé le 16 novembre 2026 ; construit dans la foulée.

## Pourquoi

`@astratra/wallet` fabrique les cartes Apple Wallet (`.pkpass`) avec `passkit-generator`.
Cette seule dépendance en tire trois autres :

- `joi`, épinglé à 17.13.4, une version qui a une faille connue. Le README conseillait une surcharge (`overrides`) que chaque application devait recopier ;
- `node-forge`, pour la signature. Plusieurs failles y ont été trouvées ces derniers mois ;
- `do-not-zip`, pour l'archive.

Une carte `.pkpass` est un format simple et stable, décrit par Apple. Le module `crypto` de Node fait toute la cryptographie nécessaire. Seule la mise en forme de la signature (PKCS#7) lui manque. Écrire nous-mêmes ces quelques centaines de lignes supprime les quatre bibliothèques et leurs alertes.

## Buts

- Garder l'API publique : `createApplePasses(options).build(carte)` renvoie toujours un `Buffer`, avec les mêmes options. Une application qui s'en sert ne change rien.
- N'utiliser que Node : `crypto`, `Buffer`. Aucune dépendance nouvelle.
- Refuser clairement, dès la fabrication, une carte qu'Apple Wallet refuserait sans rien dire : deux champs avec la même clé, une icône absente, un jeton trop court, une couleur mal écrite, un format de code-barres inconnu.

## Non-buts

- Le reste de passkit-generator, que nous n'exposons pas : les modèles en dossier, les traductions `.lproj/pass.strings`, la personnalisation NFC, les cartes d'embarquement (`boardingPass`), les lots `.pkpasses`.
- Google Wallet : `google-auth-library` est la bibliothèque officielle de Google, sans faille connue. Elle reste.

## Approches

1. **Écrire notre fabrication (choisie).** Un petit encodeur et lecteur DER, la signature CMS détachée, un ZIP sans compression. C'est peu de code, entièrement testable, sans dépendance.
2. **Appeler `openssl smime` en ligne de commande**, comme le documente Apple. Mais il faut un binaire sur chaque serveur, des fichiers temporaires pour la clé privée, et un processus lancé à chaque carte. Refusée.
3. **Une autre bibliothèque** (`@peculiar/asn1-cms`, `pkijs`…). On change de dépendance sans en supprimer : refusée, ce n'est pas ce qui était demandé.

## Ce qui est construit

`packages/wallet/src/pkpass/` :

- `der.js` : encodage DER (longueurs, entiers, OID, SET triés comme l'exige DER, temps UTC) et un lecteur minimal, pour extraire d'un certificat l'émetteur et le numéro de série ;
- `signature.js` : la signature CMS `SignedData` détachée du `manifest.json`, avec les attributs signés `contentType`, `signingTime` et `messageDigest`. Les certificats joints sont celui de l'émetteur et l'intermédiaire WWDR ;
- `zip.js` : une archive ZIP sans compression (CRC-32, noms en UTF-8) ;
- `pkpass.js` : les contrôles, `pass.json`, le `manifest.json` (SHA-1 de chaque fichier, comme l'exige Apple), la signature et l'archive.

`apple.js` garde son API et appelle `pkpass.js`. La clé privée est lue et comparée au certificat dès `createApplePasses` : une clé qui ne va pas, ou une phrase secrète fausse, échoue tout de suite, et non à la première carte.

## Choix de Claude (à relire)

- **Empreinte SHA-256 pour la signature** (passkit-generator utilisait SHA-1). La commande qu'Apple donne dans sa documentation (`openssl smime -sign`) signe en SHA-256 avec un OpenSSL récent, et SHA-1 est déconseillé. Le `manifest.json` reste en SHA-1, car c'est le format qu'Apple impose.
- **Deux champs avec la même clé sont refusés** (passkit-generator ignorait le second, avec un avertissement). Apple refuse ces cartes : mieux vaut une erreur claire à la fabrication qu'une carte qui ne s'ajoute pas.
- **Une carte sans `icon.png` est refusée** (passkit-generator avertissait seulement). Aucun appareil Apple n'ouvre une carte sans icône.
- **Sans `webServiceURL`, `authenticationToken` n'est pas écrit** (carte fixe, comme une carte de visite). Avec un `webServiceURL`, le jeton est obligatoire et doit faire au moins 16 caractères.
- **Les noms de fichiers** : chemin relatif, sans `..`, sans barre oblique inverse. `pass.json`, `manifest.json` et `signature` sont réservés.
- **Archive sans compression** : les images PNG sont déjà compressées, et Apple accepte les deux.
- **Clés RSA et EC** acceptées (les certificats Pass Type ID d'Apple sont en RSA 2048).

## Vérification

- Tests du paquet : structure de l'archive (relue par un lecteur ZIP écrit dans le test, CRC compris), `pass.json` et `manifest.json`, signature vérifiée en Node pur (empreinte et signature des attributs), et refus.
- Contrôle croisé fait une fois pendant la construction : `pass.json` et `manifest.json` identiques à ceux de passkit-generator pour la même carte, et signature acceptée par `openssl cms -verify`. Un test refait la vérification `openssl` quand l'outil est présent.
- Reste à faire avant la publication : ajouter une vraie carte sur un iPhone avec le certificat de production. C'est le seul juge final.
