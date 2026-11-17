/* Les clés de premier niveau du pass.json qui ne sont ni l'identité de la
   carte, ni son style, ni ses champs : dates, lieux, billets groupés, données
   des billets en affiche, liens du guide de l'événement… Chacune est contrôlée
   selon la documentation d'Apple (WalletPasses, « Pass »), puis écrite telle
   quelle. Une clé qu'Apple ajoutera plus tard passe par extraKeys, sans
   attendre une nouvelle version du paquet. */

function refus(message) {
  return new TypeError(`Carte Apple Wallet : ${message}`);
}

const texteNonVide = (valeur) => typeof valeur === 'string' && valeur.trim().length > 0;
const objetSimple = (valeur) => valeur !== null && typeof valeur === 'object' && !Array.isArray(valeur)
  && !(valeur instanceof Date) && !(valeur instanceof Uint8Array);

/* Date W3C avec l'heure et le fuseau, comme l'exige Apple ; le fuseau peut
   s'écrire -7:00 (exemple de la documentation). */
const DATE_W3C = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{1,2}(:?[0-5]\d)?)$/;
const EXEMPLE_DATE = '2026-12-31T20:30+01:00';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;

function date(nom, valeur) {
  if (valeur instanceof Date) {
    if (Number.isNaN(valeur.getTime())) throw refus(`${nom} est une date invalide.`);
    return valeur.toISOString();
  }
  if (typeof valeur === 'string' && DATE_W3C.test(valeur)) return valeur;
  throw refus(`${nom} doit être une Date ou un texte ISO 8601 avec l'heure et le fuseau (par exemple ${EXEMPLE_DATE}) ; reçu « ${valeur} ».`);
}

/* Les dates d'un objet libre (semantics, userInfo, extraKeys) deviennent du
   texte ISO ; ce qui ne survivrait pas au JSON est refusé plutôt que perdu. */
function jsonSur(nom, valeur) {
  if (valeur instanceof Date) return date(nom, valeur);
  if (valeur === null || typeof valeur === 'string' || typeof valeur === 'boolean') return valeur;
  if (typeof valeur === 'number') {
    if (!Number.isFinite(valeur)) throw refus(`${nom} contient un nombre invalide (${valeur}).`);
    return valeur;
  }
  if (Array.isArray(valeur)) return valeur.map((element, i) => jsonSur(`${nom}[${i}]`, element));
  if (objetSimple(valeur)) {
    const resultat = {};
    for (const [cle, element] of Object.entries(valeur)) {
      if (element !== undefined) resultat[cle] = jsonSur(`${nom}.${cle}`, element);
    }
    return resultat;
  }
  throw refus(`${nom} contient une valeur qui ne s'écrit pas en JSON (${typeof valeur}).`);
}

function texte(nom, valeur) {
  if (!texteNonVide(valeur)) throw refus(`${nom} doit être un texte non vide.`);
  return valeur;
}

function booleen(nom, valeur) {
  if (typeof valeur !== 'boolean') throw refus(`${nom} doit valoir true ou false.`);
  return valeur;
}

function adresse(nom, valeur) {
  let lue;
  try {
    lue = new URL(valeur);
  } catch {
    throw refus(`${nom} n'est pas une adresse : « ${valeur} ».`);
  }
  if (!['https:', 'http:'].includes(lue.protocol)) throw refus(`${nom} doit commencer par https://.`);
  return valeur;
}

function couleur(nom, valeur) {
  const morceaux = RGB.exec(String(valeur));
  if (!morceaux || morceaux.slice(1).some((n) => Number(n) > 255)) {
    throw refus(`la couleur ${nom} s'écrit rgb(r, g, b), chaque valeur de 0 à 255 ; reçu « ${valeur} ».`);
  }
  return valeur;
}

function nombre(nom, valeur, { min = -Infinity, max = Infinity, entier = false, strict = false } = {}) {
  const ok = typeof valeur === 'number' && Number.isFinite(valeur) && (!entier || Number.isInteger(valeur))
    && (strict ? valeur > min : valeur >= min) && valeur <= max;
  if (!ok) {
    const borne = strict ? `plus grand que ${min}` : `de ${min} à ${max}`;
    throw refus(`${nom} doit être un nombre${entier ? ' entier' : ''} ${borne} ; reçu « ${valeur} ».`);
  }
  return valeur;
}

function liste(nom, valeur, { max } = {}) {
  if (!Array.isArray(valeur) || valeur.length === 0) throw refus(`${nom} doit être une liste non vide.`);
  if (max !== undefined && valeur.length > max) throw refus(`${nom} : ${max} au plus (Apple ignore le reste) ; reçu ${valeur.length}.`);
  return valeur;
}

/* Un objet aux clés connues : une clé mal écrite est refusée, au lieu d'être
   ignorée par Apple sans un mot. */
function objetConnu(nom, valeur, cles) {
  if (!objetSimple(valeur)) throw refus(`${nom} doit être un objet.`);
  const inconnue = Object.keys(valeur).find((cle) => !cles.includes(cle));
  if (inconnue) throw refus(`${nom} : clé inconnue « ${inconnue} » (attendu : ${cles.join(', ')}).`);
  return valeur;
}

function sansVides(objet) {
  return Object.fromEntries(Object.entries(objet).filter(([, valeur]) => valeur !== undefined));
}

function plageDeDates(nom, valeur) {
  objetConnu(nom, valeur, ['date', 'startDate', 'endDate']);
  if (valeur.date !== undefined) {
    if (valeur.startDate !== undefined || valeur.endDate !== undefined) {
      throw refus(`${nom} : soit date, soit startDate et endDate, pas les deux.`);
    }
    return { date: date(`${nom}.date`, valeur.date) };
  }
  if (valeur.startDate === undefined || valeur.endDate === undefined) {
    throw refus(`${nom} : startDate et endDate vont ensemble (ou une seule date dans date).`);
  }
  const debut = date(`${nom}.startDate`, valeur.startDate);
  const fin = date(`${nom}.endDate`, valeur.endDate);
  const [t0, t1] = [Date.parse(debut), Date.parse(fin)];
  if (!Number.isNaN(t0) && !Number.isNaN(t1) && t1 <= t0) throw refus(`${nom} : endDate doit venir après startDate.`);
  return { startDate: debut, endDate: fin };
}

function lieu(nom, valeur) {
  objetConnu(nom, valeur, ['latitude', 'longitude', 'altitude', 'relevantText']);
  return sansVides({
    latitude: nombre(`${nom}.latitude`, valeur.latitude, { min: -90, max: 90 }),
    longitude: nombre(`${nom}.longitude`, valeur.longitude, { min: -180, max: 180 }),
    altitude: valeur.altitude === undefined ? undefined : nombre(`${nom}.altitude`, valeur.altitude),
    relevantText: valeur.relevantText === undefined ? undefined : texte(`${nom}.relevantText`, valeur.relevantText)
  });
}

function balise(nom, valeur) {
  objetConnu(nom, valeur, ['proximityUUID', 'major', 'minor', 'relevantText']);
  if (typeof valeur.proximityUUID !== 'string' || !UUID.test(valeur.proximityUUID)) {
    throw refus(`${nom}.proximityUUID doit être un UUID ; reçu « ${valeur.proximityUUID} ».`);
  }
  const seize = { min: 0, max: 65535, entier: true };
  return sansVides({
    proximityUUID: valeur.proximityUUID,
    major: valeur.major === undefined ? undefined : nombre(`${nom}.major`, valeur.major, seize),
    minor: valeur.minor === undefined ? undefined : nombre(`${nom}.minor`, valeur.minor, seize),
    relevantText: valeur.relevantText === undefined ? undefined : texte(`${nom}.relevantText`, valeur.relevantText)
  });
}

function nfc(nom, valeur) {
  objetConnu(nom, valeur, ['message', 'encryptionPublicKey', 'requiresAuthentication']);
  texte(`${nom}.message`, valeur.message);
  if (Buffer.byteLength(valeur.message, 'utf8') > 64) throw refus(`${nom}.message : 64 octets au plus (Apple coupe le reste).`);
  return sansVides({
    message: valeur.message,
    encryptionPublicKey: texte(`${nom}.encryptionPublicKey`, valeur.encryptionPublicKey),
    requiresAuthentication: valeur.requiresAuthentication === undefined
      ? undefined : booleen(`${nom}.requiresAuthentication`, valeur.requiresAuthentication)
  });
}

const identifiantsApp = (nom, valeur) => liste(nom, valeur)
  .map((id, i) => nombre(`${nom}[${i}]`, id, { min: 0, entier: true, strict: true }));

/* Liens du guide de l'événement (billets en affiche) et des cartes
   d'embarquement (iOS 26) ; tous en http(s). */
const ADRESSES = [
  'accessibilityURL', 'addOnURL', 'bagPolicyURL', 'contactVenueWebsite', 'directionsInformationURL',
  'merchandiseURL', 'orderFoodURL', 'parkingInformationURL', 'purchaseParkingURL', 'sellURL',
  'transferURL', 'transitInformationURL',
  'changeSeatURL', 'entertainmentURL', 'managementURL', 'purchaseAdditionalBaggageURL',
  'purchaseLoungeAccessURL', 'purchaseWifiURL', 'registerServiceAnimalURL', 'reportLostBagURL',
  'requestWheelchairURL', 'trackBagsURL', 'transitProviderWebsiteURL', 'upgradeURL'
];

/** Chaque clé de premier niveau prise en charge, avec son contrôle. */
const OPTIONS = {
  relevantDate: date,
  relevantDates: (nom, valeur) => liste(nom, valeur).map((plage, i) => plageDeDates(`${nom}[${i}]`, plage)),
  expirationDate: date,
  locations: (nom, valeur) => liste(nom, valeur, { max: 10 }).map((l, i) => lieu(`${nom}[${i}]`, l)),
  maxDistance: (nom, valeur) => nombre(nom, valeur, { min: 0, strict: true }),
  beacons: (nom, valeur) => liste(nom, valeur, { max: 10 }).map((b, i) => balise(`${nom}[${i}]`, b)),
  groupingIdentifier: texte,
  sharingProhibited: booleen,
  suppressStripShine: booleen,
  semantics: (nom, valeur) => {
    if (!objetSimple(valeur)) throw refus(`${nom} doit être un objet (les étiquettes sémantiques d'Apple).`);
    return jsonSur(nom, valeur);
  },
  userInfo: (nom, valeur) => {
    if (!objetSimple(valeur)) throw refus(`${nom} doit être un objet.`);
    return jsonSur(nom, valeur);
  },
  preferredStyleSchemes: (nom, valeur) => liste(nom, valeur).map((s, i) => texte(`${nom}[${i}]`, s)),
  eventLogoText: texte,
  footerBackgroundColor: couleur,
  useAutomaticColors: booleen,
  suppressHeaderDarkening: booleen,
  contactVenueEmail: texte,
  contactVenuePhoneNumber: texte,
  transitProviderEmail: texte,
  transitProviderPhoneNumber: texte,
  associatedStoreIdentifiers: identifiantsApp,
  auxiliaryStoreIdentifiers: identifiantsApp,
  /* Passée telle quelle à l'application : un schéma propre (monapp://) est permis. */
  appLaunchURL: texte,
  nfc,
  ...Object.fromEntries(ADRESSES.map((nom) => [nom, adresse]))
};

/* Les clés que le paquet écrit lui-même : extraKeys ne peut pas les
   remplacer, pour ne pas contourner leurs contrôles. */
const GEREES = [
  'formatVersion', 'passTypeIdentifier', 'teamIdentifier', 'serialNumber', 'organizationName',
  'description', 'logoText', 'foregroundColor', 'backgroundColor', 'labelColor', 'webServiceURL',
  'authenticationToken', 'voided', 'barcode', 'barcodes',
  'storeCard', 'generic', 'coupon', 'eventTicket', 'boardingPass', 'posterGeneric'
];

/**
 * Contrôle les clés de premier niveau et les rend prêtes à écrire.
 * @param {Record<string, unknown>} options   clés de OPTIONS (absentes : ignorées).
 * @param {Record<string, unknown>} [extra]   autres clés d'Apple, écrites telles quelles.
 */
function preparerOptions(options = {}, extra) {
  const resultat = {};
  for (const [nom, controle] of Object.entries(OPTIONS)) {
    if (options[nom] !== undefined && options[nom] !== null) resultat[nom] = controle(nom, options[nom]);
  }
  if (extra !== undefined && extra !== null) {
    if (!objetSimple(extra)) throw refus('extraKeys doit être un objet { cléApple: valeur }.');
    for (const [nom, valeur] of Object.entries(extra)) {
      if (GEREES.includes(nom)) throw refus(`extraKeys ne peut pas remplacer « ${nom} », que le paquet écrit lui-même.`);
      if (Object.hasOwn(OPTIONS, nom)) throw refus(`« ${nom} » se donne directement (avec son contrôle), pas dans extraKeys.`);
      if (valeur !== undefined) resultat[nom] = jsonSur(`extraKeys.${nom}`, valeur);
    }
  }
  return resultat;
}

module.exports = { preparerOptions, date, jsonSur, couleur, OPTIONS, NOMS_OPTIONS: Object.keys(OPTIONS) };
