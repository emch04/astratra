/* Encodage DER (X.690), réduit à ce que demande la signature d'une carte
   Apple Wallet, et un lecteur juste assez grand pour retrouver, dans un
   certificat, son émetteur et son numéro de série. */

function longueur(n) {
  if (n < 0x80) return Buffer.from([n]);
  const octets = [];
  for (let reste = n; reste > 0; reste = Math.floor(reste / 256)) octets.unshift(reste % 256);
  return Buffer.from([0x80 | octets.length, ...octets]);
}

/** Un élément complet : étiquette, longueur, contenu. */
function tlv(etiquette, contenu) {
  return Buffer.concat([Buffer.from([etiquette]), longueur(contenu.length), contenu]);
}

const sequence = (...elements) => tlv(0x30, Buffer.concat(elements));

/* DER range les éléments d'un SET OF par ordre croissant de leur encodage,
   le plus court complété par des zéros. */
function comparerEncodages(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const ecart = (a[i] ?? 0) - (b[i] ?? 0);
    if (ecart !== 0) return ecart;
  }
  return 0;
}

const trier = (elements) => [...elements].sort(comparerEncodages);

/** SET OF, trié comme l'exige DER. */
const ensemble = (elements) => tlv(0x31, Buffer.concat(trier(elements)));

/** [n] IMPLICIT SET OF : même contenu trié qu'un SET, autre étiquette. */
const ensembleImplicite = (n, elements) => tlv(0xa0 | n, Buffer.concat(trier(elements)));

/** [n] EXPLICIT : enveloppe un élément complet. */
const explicite = (n, element) => tlv(0xa0 | n, element);

/** Entier positif ou nul, assez petit pour un nombre JavaScript. */
function entier(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Entier DER invalide : ${n}`);
  const octets = [];
  for (let reste = n; reste > 0; reste = Math.floor(reste / 256)) octets.unshift(reste % 256);
  if (octets.length === 0 || octets[0] & 0x80) octets.unshift(0);
  return tlv(0x02, Buffer.from(octets));
}

function identifiant(texte) {
  const arcs = texte.split('.').map(Number);
  if (arcs.length < 2 || arcs.some((arc) => !Number.isSafeInteger(arc) || arc < 0)) {
    throw new RangeError(`Identifiant d'objet invalide : ${texte}`);
  }
  const octets = [];
  for (const arc of [arcs[0] * 40 + arcs[1], ...arcs.slice(2)]) {
    const morceaux = [arc % 128];
    for (let reste = Math.floor(arc / 128); reste > 0; reste = Math.floor(reste / 128)) morceaux.unshift(0x80 | (reste % 128));
    octets.push(...morceaux);
  }
  return tlv(0x06, Buffer.from(octets));
}

const nul = () => Buffer.from([0x05, 0x00]);
const chaineOctets = (contenu) => tlv(0x04, contenu);

/* Avant 2050, UTCTime ; ensuite, GeneralizedTime (RFC 5280, 4.1.2.5). */
function temps(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new RangeError('Date de signature invalide.');
  const deux = (n) => String(n).padStart(2, '0');
  const annee = date.getUTCFullYear();
  const suite = `${deux(date.getUTCMonth() + 1)}${deux(date.getUTCDate())}${deux(date.getUTCHours())}${deux(date.getUTCMinutes())}${deux(date.getUTCSeconds())}Z`;
  if (annee >= 1950 && annee < 2050) return tlv(0x17, Buffer.from(`${deux(annee % 100)}${suite}`, 'ascii'));
  return tlv(0x18, Buffer.from(`${String(annee).padStart(4, '0')}${suite}`, 'ascii'));
}

/** Lit l'élément qui commence à `debut`. Refuse les longueurs indéfinies (interdites en DER) et ce qui déborde. */
function lire(buffer, debut = 0) {
  if (debut + 2 > buffer.length) throw new RangeError('DER tronqué.');
  const etiquette = buffer[debut];
  if ((etiquette & 0x1f) === 0x1f) throw new RangeError('Étiquette DER longue non prise en charge.');
  let position = debut + 1;
  let taille = buffer[position];
  position += 1;
  if (taille & 0x80) {
    const nombre = taille & 0x7f;
    if (nombre === 0 || nombre > 4) throw new RangeError('Longueur DER invalide.');
    if (position + nombre > buffer.length) throw new RangeError('DER tronqué.');
    taille = 0;
    for (let i = 0; i < nombre; i += 1) taille = taille * 256 + buffer[position + i];
    position += nombre;
  }
  const fin = position + taille;
  if (fin > buffer.length) throw new RangeError('DER tronqué.');
  return { etiquette, debut, contenu: position, fin };
}

/** Les éléments contenus dans un élément construit. */
function enfants(buffer, element) {
  const liste = [];
  for (let position = element.contenu; position < element.fin;) {
    const enfant = lire(buffer, position);
    liste.push(enfant);
    position = enfant.fin;
  }
  return liste;
}

const brut = (buffer, element) => buffer.subarray(element.debut, element.fin);

/**
 * L'émetteur et le numéro de série d'un certificat X.509 (DER), tels quels :
 * c'est par eux que la signature désigne son signataire.
 */
function emetteurEtNumero(certificat) {
  const racine = lire(certificat);
  if (racine.etiquette !== 0x30 || racine.fin !== certificat.length) throw new RangeError('Certificat DER invalide.');
  const [corps] = enfants(certificat, racine);
  if (!corps || corps.etiquette !== 0x30) throw new RangeError('Certificat DER invalide.');
  const champs = enfants(certificat, corps);
  const decalage = champs[0]?.etiquette === 0xa0 ? 1 : 0;
  const numero = champs[decalage];
  const emetteur = champs[decalage + 2];
  if (numero?.etiquette !== 0x02 || emetteur?.etiquette !== 0x30) throw new RangeError('Certificat DER invalide.');
  return { emetteur: brut(certificat, emetteur), numero: brut(certificat, numero) };
}

module.exports = {
  tlv,
  sequence,
  ensemble,
  ensembleImplicite,
  explicite,
  entier,
  identifiant,
  nul,
  chaineOctets,
  temps,
  lire,
  enfants,
  brut,
  emetteurEtNumero
};
