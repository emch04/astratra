const crypto = require('node:crypto');
const { signerDetache } = require('./signature');
const { creerZip } = require('./zip');
const { preparerOptions, date: dateApple, couleur } = require('./options');

/* Fabrication d'un .pkpass : pass.json, les images, le manifest.json (SHA-1
   de chaque fichier, format imposé par Apple), sa signature, le tout dans un
   ZIP. Apple Wallet refuse sans explication une carte mal formée : tout ce
   qu'on peut contrôler ici l'est, avec un message qui dit quoi corriger. */

const TYPES = ['storeCard', 'generic', 'coupon', 'eventTicket', 'boardingPass'];
/* Écrites sur toute carte, vides comprises. */
const ZONES = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'];
/* Section « Informations » sous la carte (iOS 18) : écrite seulement si remplie. */
const ZONE_INFOS = 'additionalInfoFields';
/* Carte en affiche (posterGeneric, iOS 27), écrite à côté du style classique
   que gardent les appareils plus anciens. */
const ZONES_AFFICHE = ['headerFields', 'primaryFields', 'footerFields', 'backFields', 'additionalInfoFields'];
const TYPES_AVEC_AFFICHE = ['storeCard', 'generic', 'coupon', 'eventTicket'];
const TRANSPORTS = ['PKTransitTypeAir', 'PKTransitTypeBoat', 'PKTransitTypeBus', 'PKTransitTypeGeneric', 'PKTransitTypeTrain'];
/* Les quatre formats lus par tous les appareils, puis ceux d'iOS 27. */
const FORMATS_CLASSIQUES = ['PKBarcodeFormatQR', 'PKBarcodeFormatPDF417', 'PKBarcodeFormatAztec', 'PKBarcodeFormatCode128'];
const FORMATS_CODE = [...FORMATS_CLASSIQUES, 'PKBarcodeFormatCode39', 'PKBarcodeFormatCodabar', 'PKBarcodeFormatEAN13', 'PKBarcodeFormatI2of5'];
const COULEURS = ['foregroundColor', 'backgroundColor', 'labelColor'];
const RESERVES = ['pass.json', 'manifest.json', 'signature'];
const ICONE = /(?:^|\/)icon(?:@[23]x)?\.png$/;

function refus(message) {
  return new TypeError(`Carte Apple Wallet : ${message}`);
}

const texteNonVide = (valeur) => typeof valeur === 'string' && valeur.trim().length > 0;

/**
 * Lit et contrôle ce qui signe les cartes, une fois pour toutes : une clé qui
 * ne va pas avec le certificat, ou une phrase secrète fausse, se voit tout de
 * suite et non à la première carte demandée par un client.
 */
function preparerSignataire({ certificate, privateKey, passphrase, wwdr }) {
  let certificat;
  try {
    certificat = new crypto.X509Certificate(certificate);
  } catch {
    throw new Error('Certificat Pass Type ID illisible ou incomplet.');
  }
  let cle;
  try {
    /* Une phrase absente arrive souvent à null depuis une base : Node la
       refuserait sous cette forme. */
    cle = crypto.createPrivateKey(passphrase == null ? privateKey : { key: privateKey, passphrase });
  } catch {
    throw new Error('Clé privée Apple Wallet illisible, ou phrase secrète fausse.');
  }
  if (!certificat.checkPrivateKey(cle)) throw new Error('La clé privée ne correspond pas au certificat Apple Wallet.');
  let intermediaire;
  try {
    intermediaire = new crypto.X509Certificate(wwdr);
  } catch {
    throw new Error('Certificat intermédiaire Apple (WWDR) illisible.');
  }
  return { certificat, cle, chaine: [intermediaire] };
}

function verifierCouleurs(couleurs) {
  for (const [nom, valeur] of Object.entries(couleurs)) {
    if (!COULEURS.includes(nom)) throw refus(`couleur inconnue « ${nom} » (attendu : ${COULEURS.join(', ')}).`);
    couleur(nom, valeur);
  }
}

const valeurDeChamp = (valeur) => typeof valeur === 'string' || valeur instanceof Date
  || (typeof valeur === 'number' && Number.isFinite(valeur));

/* Contrôle les zones d'un style (eventTicket, posterGeneric…). Une clé est
   unique dans tout le style, recto, dos et informations confondus ; le style
   en affiche reprend souvent les clés du style classique, comme dans
   l'exemple d'Apple. */
function verifierChamps(contenu, zones, style) {
  const cles = new Set();
  for (const zone of zones) {
    const champs = contenu[zone];
    if (champs === undefined || champs === null) continue;
    if (!Array.isArray(champs)) throw refus(`${zone} doit être une liste de champs.`);
    for (const champ of champs) {
      if (!champ || typeof champ !== 'object' || Array.isArray(champ)) throw refus(`un champ de ${zone} n'est pas un objet.`);
      if (!texteNonVide(champ.key)) throw refus(`un champ de ${zone} n'a pas de clé (key).`);
      if (!valeurDeChamp(champ.value)) throw refus(`le champ « ${champ.key} » doit avoir une valeur (value) texte, nombre ou Date.`);
      if (champ.value instanceof Date) dateApple(`la valeur du champ « ${champ.key} »`, champ.value);
      if (champ.attributedValue !== undefined && !valeurDeChamp(champ.attributedValue)) {
        throw refus(`attributedValue du champ « ${champ.key} » doit être un texte, un nombre ou une Date.`);
      }
      if (champ.attributedValue instanceof Date) dateApple(`attributedValue du champ « ${champ.key} »`, champ.attributedValue);
      if (champ.label !== undefined && typeof champ.label !== 'string') throw refus(`le libellé du champ « ${champ.key} » doit être un texte.`);
      if (cles.has(champ.key)) {
        throw refus(`deux champs ont la clé « ${champ.key} » ; chaque clé doit être unique dans ${style}.`);
      }
      cles.add(champ.key);
    }
  }
}

function verifierCode(code) {
  if (!code || typeof code !== 'object') throw refus('le code-barres doit être un objet { message, format?, altText? }.');
  if (!texteNonVide(code.message)) throw refus('le code-barres n\'a pas de message.');
  if (!FORMATS_CODE.includes(code.format)) throw refus(`format de code-barres inconnu « ${code.format} » (attendu : ${FORMATS_CODE.join(', ')}).`);
  if (code.altText !== undefined && typeof code.altText !== 'string') throw refus('le texte du code-barres (altText) doit être un texte.');
  if (code.messageEncoding !== undefined && !texteNonVide(code.messageEncoding)) {
    throw refus('messageEncoding du code-barres doit être un nom de jeu de caractères (iso-8859-1, utf-8…).');
  }
}

/* Les codes de la carte : un seul (barcode) ou une liste (barcodes), le
   premier lisible par l'appareil étant affiché. Les formats d'iOS 27 ne
   s'affichent pas plus tôt : un format classique doit suivre, sinon le
   billet n'aurait aucun code sur les autres téléphones. */
function codesDe(pass) {
  if (pass.barcode !== undefined && pass.barcodes !== undefined) throw refus('barcode ou barcodes, pas les deux.');
  if (pass.barcodes === undefined) return pass.barcode === undefined ? [] : [pass.barcode];
  if (!Array.isArray(pass.barcodes) || pass.barcodes.length === 0) throw refus('barcodes doit être une liste non vide de codes.');
  return pass.barcodes;
}

function verifierCodes(codes) {
  codes.forEach(verifierCode);
  if (codes.length > 0 && !codes.some((code) => FORMATS_CLASSIQUES.includes(code.format))) {
    throw refus(`les formats ${codes.map((code) => code.format).join(', ')} ne s'affichent qu'à partir d'iOS 27 ; ajoutez après un code ${FORMATS_CLASSIQUES.join(', ')} pour les autres appareils.`);
  }
}

/** Contrôle la description complète d'une carte (le futur pass.json). */
function verifierPass(pass) {
  if (!TYPES.includes(pass.type)) throw refus(`type inconnu « ${pass.type} » (attendu : ${TYPES.join(', ')}).`);
  for (const nom of ['serialNumber', 'organizationName', 'description']) {
    if (!texteNonVide(pass[nom])) throw refus(`${nom} est obligatoire.`);
  }
  if (pass.logoText !== undefined && typeof pass.logoText !== 'string') throw refus('logoText doit être un texte.');
  if (pass.webServiceURL !== undefined) {
    let adresse;
    try {
      adresse = new URL(pass.webServiceURL);
    } catch {
      throw refus(`webServiceURL n'est pas une adresse : « ${pass.webServiceURL} ».`);
    }
    if (!['https:', 'http:'].includes(adresse.protocol)) throw refus('webServiceURL doit commencer par https://.');
    if (typeof pass.authenticationToken !== 'string' || pass.authenticationToken.length < 16) {
      throw refus('avec un service web, authenticationToken doit faire au moins 16 caractères (exigence Apple).');
    }
  }
  verifierCouleurs(pass.colors || {});
  if (pass.type === 'boardingPass') {
    if (!TRANSPORTS.includes(pass.transitType)) {
      throw refus(`une carte d'embarquement demande transitType (attendu : ${TRANSPORTS.join(', ')}) ; reçu « ${pass.transitType} ».`);
    }
  } else if (pass.transitType !== undefined) {
    throw refus('transitType ne sert qu\'aux cartes d\'embarquement (type boardingPass).');
  }
  verifierChamps(pass.fields || {}, [...ZONES, ZONE_INFOS], pass.type);
  if (pass.posterGeneric !== undefined && pass.posterGeneric !== null) {
    if (!TYPES_AVEC_AFFICHE.includes(pass.type)) {
      throw refus(`posterGeneric s'ajoute à une carte ${TYPES_AVEC_AFFICHE.join(', ')}, pas à ${pass.type}.`);
    }
    if (typeof pass.posterGeneric !== 'object' || Array.isArray(pass.posterGeneric)) {
      throw refus('posterGeneric doit être un objet de zones (headerFields, primaryFields…).');
    }
    const inconnue = Object.keys(pass.posterGeneric).find((zone) => !ZONES_AFFICHE.includes(zone));
    if (inconnue) throw refus(`posterGeneric : zone inconnue « ${inconnue} » (attendu : ${ZONES_AFFICHE.join(', ')}).`);
    verifierChamps(pass.posterGeneric, ZONES_AFFICHE, 'posterGeneric');
    /* Apple affiche l'affiche en priorité dès qu'elle est là : vide, elle
       cacherait la carte classique sur iOS 27. */
    if (!ZONES_AFFICHE.some((zone) => pass.posterGeneric[zone]?.length > 0)) {
      throw refus('posterGeneric n\'a aucun champ ; il cacherait la carte classique sur iOS 27.');
    }
  }
  verifierCodes(codesDe(pass));
}

/** Contrôle les fichiers joints (images) et les rend en Buffer. */
function verifierFichiers(fichiers) {
  const resultat = [];
  for (const [nom, contenu] of Object.entries(fichiers)) {
    const morceaux = nom.split('/');
    const sur = nom.length > 0 && !nom.includes('\\') && !nom.startsWith('/')
      && morceaux.every((morceau) => morceau !== '' && morceau !== '.' && morceau !== '..');
    if (!sur) throw refus(`nom de fichier refusé « ${nom} » : un chemin relatif, sans « .. » ni barre oblique inverse.`);
    if (RESERVES.includes(nom.toLowerCase())) throw refus(`« ${nom} » est fabriqué par le paquet ; il ne se fournit pas.`);
    if (!(contenu instanceof Uint8Array)) throw refus(`le fichier « ${nom} » doit être un Buffer.`);
    resultat.push({ name: nom, data: Buffer.from(contenu.buffer, contenu.byteOffset, contenu.byteLength) });
  }
  if (!resultat.some(({ name }) => ICONE.test(name))) {
    throw refus('icon.png manque ; aucun appareil Apple n\'ouvre une carte sans icône.');
  }
  return resultat;
}

/* Un champ tel qu'Apple le lit : une Date devient un texte ISO 8601. */
function champJson(champ) {
  const copie = { ...champ };
  for (const nom of ['value', 'attributedValue']) {
    if (copie[nom] instanceof Date) copie[nom] = copie[nom].toISOString();
  }
  return copie;
}

const champsDe = (contenu, zone) => (contenu?.[zone] || []).map(champJson);

/**
 * Le pass.json, dans l'ordre où Apple le documente.
 * @param {object} pass
 * @param {Record<string, unknown>} [supplement]  clés de premier niveau déjà contrôlées (preparerOptions).
 */
function passJson(pass, supplement = {}) {
  const corps = {};
  if (pass.type === 'boardingPass') corps.transitType = pass.transitType;
  /* Les cinq zones toujours présentes, vides comprises : c'est la forme que
     produisait passkit-generator, éprouvée sur les appareils. */
  for (const zone of ZONES) corps[zone] = champsDe(pass.fields, zone);
  const infos = champsDe(pass.fields, ZONE_INFOS);
  if (infos.length > 0) corps[ZONE_INFOS] = infos;
  let affiche;
  if (pass.posterGeneric) {
    affiche = {};
    for (const zone of ZONES_AFFICHE) {
      const champs = champsDe(pass.posterGeneric, zone);
      if (champs.length > 0) affiche[zone] = champs;
    }
  }
  const codes = codesDe(pass);
  return {
    formatVersion: 1,
    passTypeIdentifier: pass.passTypeIdentifier,
    teamIdentifier: pass.teamIdentifier,
    serialNumber: pass.serialNumber,
    organizationName: pass.organizationName,
    description: pass.description,
    ...(pass.logoText !== undefined ? { logoText: pass.logoText } : {}),
    ...(pass.colors || {}),
    ...(pass.webServiceURL !== undefined
      ? { webServiceURL: pass.webServiceURL, authenticationToken: pass.authenticationToken }
      : {}),
    ...(pass.voided ? { voided: true } : {}),
    ...supplement,
    ...(codes.length > 0
      ? {
        barcodes: codes.map((code) => ({
          format: code.format,
          message: code.message,
          messageEncoding: code.messageEncoding || 'utf-8',
          ...(code.altText !== undefined ? { altText: code.altText } : {})
        }))
      }
      : {}),
    [pass.type]: corps,
    ...(affiche ? { posterGeneric: affiche } : {})
  };
}

/**
 * @param {object} entree
 * @param {object} entree.pass         description de la carte (voir verifierPass).
 * @param {Record<string, Uint8Array>} entree.fichiers  images.
 * @param {ReturnType<typeof preparerSignataire>} entree.signataire
 * @param {Date} [entree.date]         heure de signature et date des fichiers.
 * @returns {Buffer} le .pkpass
 */
function fabriquerPkpass({ pass, fichiers, signataire, date = new Date() }) {
  verifierPass(pass);
  const supplement = preparerOptions(pass.options, pass.extraKeys);
  const images = verifierFichiers(fichiers);
  const contenu = [{ name: 'pass.json', data: Buffer.from(JSON.stringify(passJson(pass, supplement)), 'utf8') }, ...images];
  const manifeste = {};
  for (const { name, data } of contenu) manifeste[name] = crypto.createHash('sha1').update(data).digest('hex');
  const manifesteJson = Buffer.from(JSON.stringify(manifeste), 'utf8');
  const signature = signerDetache(manifesteJson, { ...signataire, date });
  return creerZip([
    ...contenu,
    { name: 'manifest.json', data: manifesteJson },
    { name: 'signature', data: signature }
  ], date);
}

module.exports = { fabriquerPkpass, preparerSignataire, passJson, TYPES, FORMATS_CODE };
