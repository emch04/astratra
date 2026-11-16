const http2 = require('node:http2');
const { APPLE_WWDR_G4, readPassCertificate } = require('./credentials');
const { fabriquerPkpass, preparerSignataire } = require('./pkpass/pkpass');

const APNS_PRODUCTION = 'https://api.push.apple.com';

/* Un QR code quand le format n'est pas dit ; ce qui n'est pas un objet est
   laissé tel quel, pour être refusé avec un message clair. */
function avecFormatParDefaut(code) {
  return typeof code === 'object' ? { ...code, format: code.format || 'PKBarcodeFormatQR' } : code;
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
 * @param {'storeCard'|'generic'|'coupon'|'eventTicket'} [options.type='storeCard']
 * @param {string} [options.logoText]
 */
function createApplePasses({
  certificate, privateKey, passphrase, wwdr, webServiceURL,
  organizationName, description, images = {}, colors = {}, type = 'storeCard', logoText
}) {
  const lu = readPassCertificate(certificate);
  if (!lu?.passTypeIdentifier || !lu.teamIdentifier) {
    throw new Error('Certificat Pass Type ID illisible ou incomplet.');
  }
  const { passTypeIdentifier, teamIdentifier } = lu;
  /* Absent, null ou vide (un champ de réglage laissé blanc) : celui d'Apple. */
  const signataire = preparerSignataire({ certificate, privateKey, passphrase, wwdr: wwdr || APPLE_WWDR_G4 });

  /**
   * @param {object} card
   * @param {string} card.serialNumber
   * @param {string} [card.authenticationToken] au moins 16 caractères (exigence Apple) ;
   *        obligatoire avec un webServiceURL, ignoré sans.
   * @param {Array<object>} [card.headerFields] … et primaryFields, secondaryFields, auxiliaryFields, backFields ;
   *        chaque clé (key) est unique sur toute la carte.
   * @param {{message: string, altText?: string, format?: string}} [card.barcode]
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
        description,
        /* Un logoText vide n'est pas écrit, comme avant. */
        logoText: logoText || undefined,
        colors: colors || {},
        webServiceURL,
        authenticationToken: card.authenticationToken,
        voided: Boolean(card.voided),
        fields: card,
        ...(card.barcode ? { barcode: avecFormatParDefaut(card.barcode) } : {})
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
