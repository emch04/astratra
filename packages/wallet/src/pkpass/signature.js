const crypto = require('node:crypto');
const der = require('./der');

/* Identifiants d'objets (RFC 5652, 5754, 3279, 8017). */
const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2'
};

/* Même forme que la signature produite par la commande qu'Apple documente
   (`openssl smime -sign`) : SHA-256 avec paramètre NULL. */
const algorithmeSha256 = () => der.sequence(der.identifiant(OID.sha256), der.nul());

function algorithmeDeSignature(cle) {
  if (cle.asymmetricKeyType === 'rsa') return der.sequence(der.identifiant(OID.rsaEncryption), der.nul());
  if (cle.asymmetricKeyType === 'ec') return der.sequence(der.identifiant(OID.ecdsaWithSha256));
  throw new Error(`Clé ${cle.asymmetricKeyType} non prise en charge : la clé d'un certificat Apple Wallet est RSA (ou EC).`);
}

const attribut = (oid, valeur) => der.sequence(der.identifiant(oid), der.ensemble([valeur]));

/**
 * Signature CMS détachée (PKCS#7 SignedData sans le contenu signé), celle que
 * Apple Wallet attend dans le fichier `signature` d'un .pkpass.
 *
 * @param {Buffer} contenu        ce qui est signé : le manifest.json.
 * @param {object} signataire
 * @param {crypto.X509Certificate} signataire.certificat  certificat Pass Type ID.
 * @param {crypto.KeyObject} signataire.cle               sa clé privée.
 * @param {crypto.X509Certificate[]} [signataire.chaine]  certificats joints en plus (l'intermédiaire WWDR).
 * @param {Date} [signataire.date]                        heure de signature.
 * @returns {Buffer} la signature, en DER.
 */
function signerDetache(contenu, { certificat, cle, chaine = [], date = new Date() }) {
  const algorithme = algorithmeDeSignature(cle);
  const empreinte = crypto.createHash('sha256').update(contenu).digest();
  const attributs = [
    attribut(OID.contentType, der.identifiant(OID.data)),
    attribut(OID.signingTime, der.temps(date)),
    attribut(OID.messageDigest, der.chaineOctets(empreinte))
  ];
  /* La signature porte sur les attributs encodés comme un SET (étiquette
     0x31) ; dans la structure, ils sont rangés sous [0] IMPLICIT. */
  const attributsSignes = der.ensemble(attributs);
  const signature = crypto.sign('sha256', attributsSignes, cle);

  const { emetteur, numero } = der.emetteurEtNumero(certificat.raw);
  const infoSignataire = der.sequence(
    der.entier(1),
    der.sequence(emetteur, numero),
    algorithmeSha256(),
    der.ensembleImplicite(0, attributs),
    algorithme,
    der.chaineOctets(signature)
  );

  /* Chaque certificat une seule fois, même si l'intermédiaire passé est le
     certificat de l'émetteur (cas des essais). */
  const certificats = [];
  for (const x509 of [certificat, ...chaine]) {
    if (!certificats.some((deja) => deja.equals(x509.raw))) certificats.push(x509.raw);
  }

  const donneesSignees = der.sequence(
    der.entier(1),
    der.ensemble([algorithmeSha256()]),
    der.sequence(der.identifiant(OID.data)),
    der.ensembleImplicite(0, certificats),
    der.ensemble([infoSignataire])
  );
  return der.sequence(der.identifiant(OID.signedData), der.explicite(0, donneesSignees));
}

module.exports = { signerDetache, OID };
