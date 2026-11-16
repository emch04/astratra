const crypto = require('node:crypto');
const { signerDetache } = require('./signature');
const { creerZip } = require('./zip');

/* Fabrication d'un .pkpass : pass.json, les images, le manifest.json (SHA-1
   de chaque fichier, format imposé par Apple), sa signature, le tout dans un
   ZIP. Apple Wallet refuse sans explication une carte mal formée : tout ce
   qu'on peut contrôler ici l'est, avec un message qui dit quoi corriger. */

const TYPES = ['storeCard', 'generic', 'coupon', 'eventTicket'];
const ZONES = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'];
const FORMATS_CODE = ['PKBarcodeFormatQR', 'PKBarcodeFormatPDF417', 'PKBarcodeFormatAztec', 'PKBarcodeFormatCode128'];
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
    const morceaux = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(String(valeur));
    if (!morceaux || morceaux.slice(1).some((n) => Number(n) > 255)) {
      throw refus(`la couleur ${nom} s'écrit rgb(r, g, b), chaque valeur de 0 à 255 ; reçu « ${valeur} ».`);
    }
  }
}

function verifierChamps(contenu) {
  const cles = new Set();
  for (const zone of ZONES) {
    const champs = contenu[zone];
    if (champs === undefined || champs === null) continue;
    if (!Array.isArray(champs)) throw refus(`${zone} doit être une liste de champs.`);
    for (const champ of champs) {
      if (!champ || typeof champ !== 'object' || Array.isArray(champ)) throw refus(`un champ de ${zone} n'est pas un objet.`);
      if (!texteNonVide(champ.key)) throw refus(`un champ de ${zone} n'a pas de clé (key).`);
      const valeurOk = typeof champ.value === 'string' || (typeof champ.value === 'number' && Number.isFinite(champ.value));
      if (!valeurOk) throw refus(`le champ « ${champ.key} » doit avoir une valeur (value) texte ou nombre.`);
      if (champ.label !== undefined && typeof champ.label !== 'string') throw refus(`le libellé du champ « ${champ.key} » doit être un texte.`);
      /* Apple refuse une carte dont deux champs partagent une clé, recto et
         dos confondus. */
      if (cles.has(champ.key)) throw refus(`deux champs ont la clé « ${champ.key} » ; chaque clé doit être unique sur toute la carte.`);
      cles.add(champ.key);
    }
  }
}

function verifierCode(code) {
  if (!code || typeof code !== 'object') throw refus('le code-barres doit être un objet { message, format?, altText? }.');
  if (!texteNonVide(code.message)) throw refus('le code-barres n\'a pas de message.');
  if (!FORMATS_CODE.includes(code.format)) throw refus(`format de code-barres inconnu « ${code.format} » (attendu : ${FORMATS_CODE.join(', ')}).`);
  if (code.altText !== undefined && typeof code.altText !== 'string') throw refus('le texte du code-barres (altText) doit être un texte.');
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
  verifierChamps(pass.fields || {});
  if (pass.barcode !== undefined) verifierCode(pass.barcode);
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

/** Le pass.json, dans l'ordre où Apple le documente. */
function passJson(pass) {
  const corps = {};
  /* Les cinq zones toujours présentes, vides comprises : c'est la forme que
     produisait passkit-generator, éprouvée sur les appareils. */
  for (const zone of ZONES) corps[zone] = (pass.fields?.[zone] || []).map((champ) => ({ ...champ }));
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
    ...(pass.barcode
      ? {
        barcodes: [{
          format: pass.barcode.format,
          message: pass.barcode.message,
          messageEncoding: 'utf-8',
          ...(pass.barcode.altText !== undefined ? { altText: pass.barcode.altText } : {})
        }]
      }
      : {}),
    [pass.type]: corps
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
  const images = verifierFichiers(fichiers);
  const contenu = [{ name: 'pass.json', data: Buffer.from(JSON.stringify(passJson(pass)), 'utf8') }, ...images];
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
