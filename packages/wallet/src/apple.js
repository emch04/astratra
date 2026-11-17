const http2 = require('node:http2');
const { APPLE_WWDR_G4, readPassCertificate } = require('./credentials');
const { fabriquerPkpass, preparerSignataire } = require('./pkpass/pkpass');
const { NOMS_OPTIONS } = require('./pkpass/options');

const APNS_PRODUCTION = 'https://api.push.apple.com';

/* Un QR code quand le format n'est pas dit ; ce qui n'est pas un objet est
   laissé tel quel, pour être refusé avec un message clair. */
function avecFormatParDefaut(code) {
  return code && typeof code === 'object' ? { ...code, format: code.format || 'PKBarcodeFormatQR' } : code;
}

/* Les clés de premier niveau (dates, lieux, billets groupés…) données à la
   fabrique valent pour toutes ses cartes ; une carte les remplace une à une. */
function optionsDe(source) {
  const options = {};
  for (const nom of NOMS_OPTIONS) {
    if (source[nom] !== undefined && source[nom] !== null) options[nom] = source[nom];
  }
  return options;
}

/* Les extraKeys de la carte s'ajoutent à ceux de la fabrique ; ce qui n'est
   pas un objet passe tel quel, pour être refusé avec un message clair. */
function fusionnerExtra(communs, propres) {
  if (communs === undefined || communs === null) return propres;
  if (propres === undefined || propres === null) return communs;
  const objet = (valeur) => typeof valeur === 'object' && !Array.isArray(valeur);
  if (!objet(communs)) return communs;
  if (!objet(propres)) return propres;
  return { ...communs, ...propres };
}

/**
 * Fabrique de cartes Apple Wallet (storeCard par défaut), signées avec le
 * certificat Pass Type ID de l'émetteur.
 *
 * L'identifiant de carte et l'équipe se lisent dans le certificat. Le style
 * (couleurs, logo) est celui de l'émetteur ; le contenu (champs, bande, QR)
 * change d'une carte à l'autre.
 *
 * Le .pkpass est fabriqué par le paquet lui-même (pass.json, manifest,
 * signature CMS, ZIP), sans autre dépendance que Node.
 *
 * @param {object} options
 * @param {string} options.certificate   certificat Pass Type ID (PEM).
 * @param {string} options.privateKey    clé privée associée (PEM).
 * @param {string} [options.passphrase]
 * @param {string} [options.wwdr]        certificat intermédiaire ; WWDR G4 par défaut.
 * @param {string} [options.webServiceURL] base du service web de mise à jour (…/v1 ajouté par Apple) ;
 *        sans elle, la carte est fixe.
 * @param {string} options.organizationName
 * @param {string} options.description
 * @param {Record<string, Buffer>} options.images  images communes : icon.png (obligatoire), icon@2x.png, logo.png…
 * @param {{foregroundColor?: string, backgroundColor?: string, labelColor?: string}} [options.colors]  au format rgb(r, g, b).
 * @param {'storeCard'|'generic'|'coupon'|'eventTicket'|'boardingPass'} [options.type='storeCard']
 * @param {string} [options.transitType]  carte d'embarquement : PKTransitTypeAir, Boat, Bus, Generic ou Train.
 * @param {string} [options.logoText]
 * @param {Record<string, unknown>} [options.extraKeys]  autres clés du pass.json, écrites telles quelles
 *        (une clé qu'Apple ajoute après cette version du paquet).
 * Toutes les clés de premier niveau d'Apple prises en charge (relevantDates,
 * locations, semantics, groupingIdentifier… voir index.d.ts) se donnent ici
 * pour toutes les cartes, ou dans chaque carte.
 */
function createApplePasses({
  certificate, privateKey, passphrase, wwdr, webServiceURL,
  organizationName, description, images = {}, colors = {}, type = 'storeCard', logoText,
  transitType, extraKeys, ...reglages
}) {
  const lu = readPassCertificate(certificate);
  if (!lu?.passTypeIdentifier || !lu.teamIdentifier) {
    throw new Error('Certificat Pass Type ID illisible ou incomplet.');
  }
  const { passTypeIdentifier, teamIdentifier } = lu;
  /* Absent, null ou vide (un champ de réglage laissé blanc) : celui d'Apple. */
  const signataire = preparerSignataire({ certificate, privateKey, passphrase, wwdr: wwdr || APPLE_WWDR_G4 });
  const optionsCommunes = optionsDe(reglages);

  /**
   * @param {object} card
   * @param {string} card.serialNumber
   * @param {string} [card.authenticationToken] au moins 16 caractères (exigence Apple) ;
   *        obligatoire avec un webServiceURL, ignoré sans.
   * @param {Array<object>} [card.headerFields] … et primaryFields, secondaryFields, auxiliaryFields, backFields,
   *        additionalInfoFields ; chaque clé (key) est unique sur toute la carte.
   * @param {{message: string, altText?: string, format?: string}} [card.barcode]
   * @param {Array<{message: string, altText?: string, format?: string}>} [card.barcodes] plusieurs codes,
   *        le premier lisible par l'appareil étant affiché (à la place de barcode).
   * @param {object} [card.posterGeneric] zones de la carte en affiche (iOS 27).
   * @param {string} [card.description] remplace celle de la fabrique (« Billet pour… »).
   * @param {string} [card.logoText] remplace celui de la fabrique.
   * @param {object} [card.colors] remplacent celles de la fabrique, une à une.
   * @param {string} [card.transitType] remplace celui de la fabrique.
   * @param {Record<string, unknown>} [card.extraKeys] s'ajoutent à ceux de la fabrique.
   * @param {Record<string, Buffer>} [card.images] images propres à cette carte (strip.png…), prioritaires.
   * @param {boolean} [card.voided] carte annulée : Apple Wallet la grise et la
   *        déclare inutilisable. C'est la seule façon, côté émetteur, de
   *        retirer une carte déjà ajoutée : seul son porteur peut l'effacer.
   * @returns {Buffer} le .pkpass
   */
  function build(card) {
    return fabriquerPkpass({
      pass: {
        type,
        passTypeIdentifier,
        teamIdentifier,
        serialNumber: card.serialNumber,
        organizationName,
        description: card.description ?? description,
        /* Un logoText vide n'est pas écrit, comme avant. */
        logoText: (card.logoText ?? logoText) || undefined,
        colors: { ...(colors || {}), ...(card.colors || {}) },
        webServiceURL,
        authenticationToken: card.authenticationToken,
        voided: Boolean(card.voided),
        transitType: card.transitType ?? transitType,
        fields: card,
        ...(card.posterGeneric ? { posterGeneric: card.posterGeneric } : {}),
        ...(card.barcode ? { barcode: avecFormatParDefaut(card.barcode) } : {}),
        ...(card.barcodes !== undefined
          ? { barcodes: Array.isArray(card.barcodes) ? card.barcodes.map(avecFormatParDefaut) : card.barcodes }
          : {}),
        options: { ...optionsCommunes, ...optionsDe(card) },
        extraKeys: fusionnerExtra(extraKeys, card.extraKeys)
      },
      fichiers: { ...images, ...(card.images || {}) },
      signataire
    });
  }

  return { passTypeIdentifier, teamIdentifier, expiresAt: lu.expiresAt, build };
}

/**
 * Prévient un appareil qu'une carte a changé : Apple Wallet revient alors
 * chercher la nouvelle version auprès du service web. La notification est
 * vide par conception (Apple l'exige).
 *
 * Rejette avec `error.status` : 400 et 410 veulent dire que le jeton est mort
 * et doit être oublié.
 */
function sendApplePassUpdate(pushToken, { certificate, privateKey, passphrase, passTypeIdentifier, connect = http2.connect, host = APNS_PRODUCTION }) {
  return new Promise((resolve, reject) => {
    const session = connect(host, { cert: certificate, key: privateKey, passphrase });
    session.once('error', reject);
    const requete = session.request({
      ':method': 'POST',
      ':path': `/3/device/${pushToken}`,
      'apns-topic': passTypeIdentifier
    });
    let statut;
    requete.on('response', (headers) => { statut = Number(headers[':status']); });
    requete.on('error', reject);
    requete.on('end', () => {
      session.close();
      if (statut >= 200 && statut < 300) resolve(statut);
      else {
        const error = new Error(`APNs a répondu ${statut || 'sans statut'}`);
        error.status = statut;
        reject(error);
      }
    });
    requete.end('{}');
  });
}

/**
 * Prévient tous les appareils qui portent une carte, et oublie les jetons que
 * Apple déclare morts. Rejette si au moins un envoi a échoué pour une autre
 * raison.
 */
async function notifyApplePass({ registrations, passTypeIdentifier, serialNumber, ...apns }) {
  const inscrits = await registrations.listForPass(passTypeIdentifier, serialNumber);
  const resultats = await Promise.allSettled(inscrits.map(async ({ pushToken }) => {
    try {
      await sendApplePassUpdate(pushToken, { ...apns, passTypeIdentifier });
    } catch (error) {
      if ([400, 410].includes(error.status)) {
        await registrations.forgetPushToken(pushToken);
        return;
      }
      throw error;
    }
  }));
  const echec = resultats.find((resultat) => resultat.status === 'rejected');
  if (echec) throw echec.reason;
  return inscrits.length;
}

module.exports = { createApplePasses, sendApplePassUpdate, notifyApplePass };
