# @astratra/s3

Un client S3 sans dépendance, pour **AWS S3, Cloudflare R2, MinIO, SeaweedFS**
et tout service compatible : déposer, lire (en entier, une plage ou en flux),
lire les en-têtes, supprimer (un ou mille objets), lister, et créer des liens
signés. La signature AWS version 4 est écrite avec `node:crypto`.

Il remplace `@aws-sdk/client-s3` et `@aws-sdk/s3-request-presigner` pour ces
usages : le SDK installe une centaine de paquets, celui-ci aucun.

```js
const { createS3Client } = require('@astratra/s3');

const s3 = createS3Client({
  endpoint: `https://${process.env.R2_COMPTE}.r2.cloudflarestorage.com`, // sans endpoint : region AWS
  region: 'auto',                                                         // « auto » pour R2
  accessKeyId: process.env.R2_CLE,
  secretAccessKey: process.env.R2_SECRET,
  bucket: 'medias',
});

await s3.putObject({ key: 'produits/42.webp', body: image, contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
const { body, contentType } = await s3.getObject({ key: 'produits/42.webp' });
const debut = await s3.getObject({ key: 'video.mp4', range: 'bytes=0-1048575' });
const { stream } = await s3.getObjectStream({ key: 'archive.zip' }); // gros fichier : en flux
await s3.headObject({ key: 'produits/42.webp' });                      // absent : S3Error « NotFound »
await s3.deleteObject({ key: 'produits/42.webp' });
await s3.deleteObjects({ keys: ['a.webp', 'b.webp'] });

const page = await s3.listObjects({ prefix: 'produits/', maxKeys: 100 });
for await (const objet of s3.iterateObjects({ prefix: 'produits/' })) console.log(objet.key, objet.size);
```

## Les liens signés

```js
// Lire : le navigateur va chercher l'objet chez le service, le serveur ne sert aucun octet.
const lien = s3.presignUrl({ key: 'photos/1.jpg', expiresIn: 900 });

// Déposer depuis le navigateur : le type est signé, le navigateur ne peut pas en envoyer un autre.
const depot = s3.presignUrl({ key: 'photos/2.webp', method: 'PUT', contentType: 'image/webp', expiresIn: 300 });
// fetch(depot, { method: 'PUT', headers: { 'content-type': 'image/webp' }, body: fichier })
```

Un lien dure au plus 7 jours (la limite d'AWS). `responseContentDisposition`
fait télécharger le fichier sous un nom choisi.

## Les erreurs

Elles ont la forme de celles du SDK : `name` est le code S3 (`NoSuchKey`,
`AccessDenied`, `SignatureDoesNotMatch`, `NotFound` pour un HEAD absent…) et
`$metadata.httpStatusCode` le statut. Le code qui triait les erreurs du SDK
ne change pas.

Aucun nouvel essai n'est fait en cachette : c'est au projet de décider ce qui
se relance (une lecture, oui ; un dépôt, à voir). `@astratra/resilience` le
fait bien.

## Ce qui est plus strict que le SDK

- **Les clés** : une clé vide, qui commence par « / », qui contient un
  segment « . » ou « .. » ou un caractère de contrôle est refusée. S3 les
  accepte, mais elles se lisent mal, et certains services les normalisent en
  route.
- **L'adresse du service** : https:// seulement, sauf vers la machine
  elle-même (`http://127.0.0.1:9000` pour un MinIO de développement). Sans
  identifiants ni chemin dans l'adresse.
- **Le service ne peut pas noyer le serveur** : délai de 30 s
  (`timeoutMs`), un objet lu en mémoire jusqu'à 100 Mio (`maxBytes`, refusé
  dès l'annonce de sa taille), une réponse d'erreur ou de liste lue jusqu'à
  1 Mio, une redirection jamais suivie.
- **Les réponses XML** sont lues sans DOCTYPE ni entités déclarées : ni
  attaque XXE, ni « milliard de rires ».
- **Les en-têtes** (type, cache, métadonnées) sont refusés s'ils contiennent
  un retour à la ligne ; les métadonnées font 2 Ko au plus, comme sur S3.
- **Un lien de dépôt signe le type de contenu.** Le SDK ne le signe pas, et
  il ajoute à ses liens de dépôt une somme CRC32 du corps vide, qui fait
  échouer un vrai dépôt.
- Aucune somme CRC n'est ajoutée aux requêtes : le hachage SHA-256 du corps
  est signé (R2 refusait les sommes ajoutées par les SDK récents).

## Pour aller plus bas

`signRequest` et `presignQuery` signent n'importe quelle requête S3 (ou d'un
autre service AWS) ; `describeRequest(opération, entrée)` montre la requête
signée qu'enverrait une opération, sans l'envoyer.

## Tests

```bash
npm test --workspace @astratra/s3
npm run verify:mutations --workspace @astratra/s3   # 23 mutations

# Avec un vrai service (SeaweedFS ou MinIO dans Docker, R2…) :
S3_TEST_ENDPOINT=http://127.0.0.1:8333 S3_TEST_ACCESS_KEY=… S3_TEST_SECRET_KEY=… S3_TEST_BUCKET=essai \
  npm test --workspace @astratra/s3
```

Les signatures sont vérifiées sur les exemples de la documentation d'AWS, et
comparées au SDK AWS v3 (signatures, requêtes, liens et lecture des réponses
enregistrés une fois, `scripts/record-aws-sdk-reference.cjs`).
