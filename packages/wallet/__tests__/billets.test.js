/**
 * Billets et cartes riches : zone « Informations », dates et lieux qui font
 * remonter la carte, billets groupés, étiquettes sémantiques, carte en
 * affiche, plusieurs codes-barres, cartes d'embarquement, clés futures
 * d'Apple (extraKeys) et billets Google.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createApplePasses, createGoogleWallet } = require('../src');

const lire = (nom) => fs.readFileSync(path.join(__dirname, 'fixtures', nom));
const CERT = lire('pass-test.pem').toString();
const CLE = lire('pass-test.key').toString();
const PIXEL = lire('pixel.png');

const fabrique = (options = {}) => createApplePasses({
  certificate: CERT, privateKey: CLE, wwdr: CERT,
  organizationName: 'Théâtre du Port', description: 'Billet', images: { 'icon.png': PIXEL },
  type: 'eventTicket', ...options
});

/* Les fichiers d'un .pkpass (ZIP sans compression), CRC contrôlés. */
function fichiersDe(pkpass) {
  const fin = pkpass.length - 22;
  let position = pkpass.readUInt32LE(fin + 16);
  const fichiers = new Map();
  for (let i = 0; i < pkpass.readUInt16LE(fin + 10); i += 1) {
    const taille = pkpass.readUInt32LE(position + 20);
    const longueurNom = pkpass.readUInt16LE(position + 28);
    const local = pkpass.readUInt32LE(position + 42);
    const nom = pkpass.subarray(position + 46, position + 46 + longueurNom).toString('utf8');
    const debut = local + 30 + pkpass.readUInt16LE(local + 26) + pkpass.readUInt16LE(local + 28);
    const donnees = pkpass.subarray(debut, debut + taille);
    expect(zlib.crc32(donnees)).toBe(pkpass.readUInt32LE(position + 16));
    fichiers.set(nom, donnees);
    position += 46 + longueurNom;
  }
  return fichiers;
}

const passDe = (pkpass) => JSON.parse(fichiersDe(pkpass).get('pass.json').toString('utf8'));
const billet = (carte = {}, options) => passDe(fabrique(options).build({ serialNumber: 'B-1', ...carte }));

describe('billet de spectacle complet', () => {
  const carte = {
    primaryFields: [{ key: 'spectacle', label: 'SPECTACLE', value: 'Le Cid' }],
    secondaryFields: [{ key: 'placement', label: 'PLACE', value: 'Orchestre, rang F, 12' }],
    auxiliaryFields: [{ key: 'date', label: 'DATE', value: new Date('2026-12-31T19:30:00Z'), dateStyle: 'PKDateStyleMedium', timeStyle: 'PKDateStyleShort' }],
    backFields: [{ key: 'conditions', label: 'CONDITIONS', value: 'Billet ni repris ni échangé.' }],
    additionalInfoFields: [{ key: 'portes', label: 'OUVERTURE DES PORTES', value: '19 h' }],
    relevantDates: [{ startDate: '2026-12-31T19:00+01:00', endDate: '2026-12-31T23:30+01:00' }],
    expirationDate: new Date('2027-01-01T06:00:00Z'),
    locations: [{ latitude: 43.2965, longitude: 5.3698, relevantText: 'Vous arrivez au théâtre' }],
    maxDistance: 300,
    groupingIdentifier: 'commande-2026-0042',
    sharingProhibited: true,
    semantics: {
      eventName: 'Le Cid', venueName: 'Théâtre du Port', venueRegionName: 'Marseille', venueRoom: 'Grande salle',
      performerNames: ['Troupe du Port'], eventStartDate: new Date('2026-12-31T19:30:00Z'),
      seats: [{ seatSection: 'Orchestre', seatRow: 'F', seatNumber: '12' }]
    },
    preferredStyleSchemes: ['posterEventTicket', 'eventTicket'],
    eventLogoText: 'Théâtre du Port',
    directionsInformationURL: 'https://theatre.example/acces',
    contactVenuePhoneNumber: '+33 4 00 00 00 00',
    barcode: { message: 'B-1-7F3A', format: 'PKBarcodeFormatAztec', altText: 'B-1' }
  };

  test('toutes les clés arrivent dans le pass.json, les dates en ISO 8601', () => {
    const pass = billet(carte);
    expect(pass.eventTicket.additionalInfoFields).toEqual([{ key: 'portes', label: 'OUVERTURE DES PORTES', value: '19 h' }]);
    expect(pass.eventTicket.auxiliaryFields[0]).toEqual({
      key: 'date', label: 'DATE', value: '2026-12-31T19:30:00.000Z', dateStyle: 'PKDateStyleMedium', timeStyle: 'PKDateStyleShort'
    });
    expect(pass).toMatchObject({
      relevantDates: [{ startDate: '2026-12-31T19:00+01:00', endDate: '2026-12-31T23:30+01:00' }],
      expirationDate: '2027-01-01T06:00:00.000Z',
      locations: [{ latitude: 43.2965, longitude: 5.3698, relevantText: 'Vous arrivez au théâtre' }],
      maxDistance: 300,
      groupingIdentifier: 'commande-2026-0042',
      sharingProhibited: true,
      preferredStyleSchemes: ['posterEventTicket', 'eventTicket'],
      eventLogoText: 'Théâtre du Port',
      directionsInformationURL: 'https://theatre.example/acces',
      contactVenuePhoneNumber: '+33 4 00 00 00 00',
      barcodes: [{ format: 'PKBarcodeFormatAztec', message: 'B-1-7F3A', messageEncoding: 'utf-8', altText: 'B-1' }]
    });
    expect(pass.semantics.eventStartDate).toBe('2026-12-31T19:30:00.000Z');
    expect(pass.semantics.seats).toEqual([{ seatSection: 'Orchestre', seatRow: 'F', seatNumber: '12' }]);
  });

  test('le manifeste couvre le pass.json et les images', () => {
    const fichiers = fichiersDe(fabrique().build({ serialNumber: 'B-1', ...carte, images: { 'background.png': PIXEL, 'thumbnail.png': PIXEL } }));
    const manifeste = JSON.parse(fichiers.get('manifest.json').toString());
    expect(Object.keys(manifeste).sort()).toEqual(['background.png', 'icon.png', 'pass.json', 'thumbnail.png']);
    for (const [nom, empreinte] of Object.entries(manifeste)) {
      expect(crypto.createHash('sha1').update(fichiers.get(nom)).digest('hex')).toBe(empreinte);
    }
  });

  test('une carte sans rien de nouveau n’a ni zone d’informations ni clé de plus', () => {
    const pass = billet({ primaryFields: [{ key: 'a', value: 'x' }] }, { type: 'storeCard' });
    expect(Object.keys(pass.storeCard)).toEqual(['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields']);
    expect(Object.keys(pass)).toEqual(['formatVersion', 'passTypeIdentifier', 'teamIdentifier', 'serialNumber', 'organizationName', 'description', 'storeCard']);
  });

  test('une zone d’informations vide ou nulle n’est pas écrite', () => {
    expect(billet({ additionalInfoFields: [] }).eventTicket).not.toHaveProperty('additionalInfoFields');
    expect(billet({ additionalInfoFields: null }).eventTicket).not.toHaveProperty('additionalInfoFields');
  });
});

describe('réglages communs et réglages de chaque carte', () => {
  test('la fabrique donne les valeurs de toutes ses cartes, chaque carte les remplace', () => {
    const options = {
      locations: [{ latitude: 43.3, longitude: 5.37 }],
      sharingProhibited: true,
      colors: { backgroundColor: 'rgb(20, 20, 20)', foregroundColor: 'rgb(255, 255, 255)' },
      logoText: 'Théâtre',
      extraKeys: { userInfoVersion: 1, featuredActions: [{ action: 'viewSchedule' }] }
    };
    const commun = billet({}, options);
    expect(commun).toMatchObject({ locations: [{ latitude: 43.3, longitude: 5.37 }], sharingProhibited: true, logoText: 'Théâtre', userInfoVersion: 1 });
    const propre = billet({
      sharingProhibited: false,
      description: 'Billet pour Le Cid',
      logoText: 'Le Cid',
      colors: { backgroundColor: 'rgb(120, 0, 0)' },
      extraKeys: { userInfoVersion: 2 }
    }, options);
    expect(propre).toMatchObject({
      locations: [{ latitude: 43.3, longitude: 5.37 }],
      sharingProhibited: false,
      description: 'Billet pour Le Cid',
      logoText: 'Le Cid',
      backgroundColor: 'rgb(120, 0, 0)',
      foregroundColor: 'rgb(255, 255, 255)',
      userInfoVersion: 2,
      featuredActions: [{ action: 'viewSchedule' }]
    });
  });

  test('une valeur null dans la carte garde celle de la fabrique', () => {
    expect(billet({ groupingIdentifier: null }, { groupingIdentifier: 'saison-2026' }).groupingIdentifier).toBe('saison-2026');
  });

  test('une clé inconnue dans la carte reste ignorée, comme avant', () => {
    expect(billet({ clientInterne: 42 })).not.toHaveProperty('clientInterne');
  });
});

describe('codes-barres', () => {
  test('plusieurs codes, QR par défaut, encodage au choix', () => {
    const pass = billet({ barcodes: [
      { message: '4006381333931', format: 'PKBarcodeFormatEAN13' },
      { message: 'B-1', messageEncoding: 'iso-8859-1' }
    ] });
    expect(pass.barcodes).toEqual([
      { format: 'PKBarcodeFormatEAN13', message: '4006381333931', messageEncoding: 'utf-8' },
      { format: 'PKBarcodeFormatQR', message: 'B-1', messageEncoding: 'iso-8859-1' }
    ]);
  });

  test.each([
    ['un format d’iOS 27 seul', { barcodes: [{ message: '1', format: 'PKBarcodeFormatCode39' }] }, /iOS 27/],
    ['barcode et barcodes ensemble', { barcode: { message: '1' }, barcodes: [{ message: '1' }] }, /pas les deux/],
    ['une liste vide', { barcodes: [] }, /liste non vide/],
    ['une liste qui n’en est pas une', { barcodes: { message: '1' } }, /liste non vide/],
    ['un code sans message dans la liste', { barcodes: [{ message: 'a' }, { format: 'PKBarcodeFormatQR' }] }, /pas de message/],
    ['un encodage vide', { barcode: { message: '1', messageEncoding: '' } }, /messageEncoding/]
  ])('refusé : %s', (_nom, carte, message) => {
    expect(() => billet(carte)).toThrow(message);
  });
});

describe('carte d’embarquement', () => {
  test('le type de transport est écrit en tête du style', () => {
    const pass = billet({
      primaryFields: [{ key: 'depart', label: 'MARSEILLE', value: 'MRS' }, { key: 'arrivee', label: 'PARIS', value: 'PLY' }]
    }, { type: 'boardingPass', transitType: 'PKTransitTypeTrain' });
    expect(Object.keys(pass.boardingPass)[0]).toBe('transitType');
    expect(pass.boardingPass.transitType).toBe('PKTransitTypeTrain');
  });

  test('chaque carte peut changer de transport', () => {
    const pass = billet({ transitType: 'PKTransitTypeBus' }, { type: 'boardingPass', transitType: 'PKTransitTypeTrain' });
    expect(pass.boardingPass.transitType).toBe('PKTransitTypeBus');
  });

  test.each([
    ['transport inconnu', {}, { type: 'boardingPass', transitType: 'PKTransitTypeRocket' }, /demande transitType/],
    ['transport sur un billet', {}, { transitType: 'PKTransitTypeAir' }, /ne sert qu'aux cartes d'embarquement/]
  ])('refusé : %s', (_nom, carte, options, message) => {
    expect(() => billet(carte, options)).toThrow(message);
  });
});

describe('carte en affiche (iOS 27)', () => {
  test('écrite à côté du style classique, mêmes clés permises, zones vides omises', () => {
    const pass = billet({
      primaryFields: [{ key: 'membre', label: 'MEMBRE', value: 'Karim' }],
      posterGeneric: {
        primaryFields: [{ key: 'membre', label: 'MEMBRE', value: 'Karim' }],
        footerFields: [{ key: 'niveau', label: 'NIVEAU', value: 'Or' }],
        backFields: []
      }
    }, { type: 'generic' });
    expect(pass.generic.primaryFields).toHaveLength(1);
    expect(pass.posterGeneric).toEqual({
      primaryFields: [{ key: 'membre', label: 'MEMBRE', value: 'Karim' }],
      footerFields: [{ key: 'niveau', label: 'NIVEAU', value: 'Or' }]
    });
  });

  test.each([
    ['zone inconnue', { posterGeneric: { secondaryFields: [] } }, {}, /zone inconnue « secondaryFields »/],
    ['sur une carte d’embarquement', { posterGeneric: {} }, { type: 'boardingPass', transitType: 'PKTransitTypeAir' }, /pas à boardingPass/],
    ['pas un objet', { posterGeneric: [] }, {}, /doit être un objet/],
    ['sans aucun champ', { posterGeneric: { primaryFields: [], backFields: null } }, {}, /aucun champ/],
    ['clé en double dans l’affiche', { posterGeneric: { headerFields: [{ key: 'a', value: '1' }], footerFields: [{ key: 'a', value: '2' }] } }, {}, /unique dans posterGeneric/]
  ])('refusé : %s', (_nom, carte, options, message) => {
    expect(() => billet(carte, options)).toThrow(message);
  });
});

describe('contrôle des clés de premier niveau', () => {
  test.each([
    ['date sans fuseau', { expirationDate: '2026-12-31T20:30' }, /fuseau/],
    ['date sans heure', { relevantDate: '2026-12-31' }, /fuseau/],
    ['date invalide', { expirationDate: new Date('pas une date') }, /date invalide/],
    ['plage avec date et startDate', { relevantDates: [{ date: '2026-12-31T20:30Z', startDate: '2026-12-31T20:30Z' }] }, /pas les deux/],
    ['plage sans fin', { relevantDates: [{ startDate: '2026-12-31T20:30Z' }] }, /vont ensemble/],
    ['plage à l’envers', { relevantDates: [{ startDate: '2026-12-31T23:00Z', endDate: '2026-12-31T20:00Z' }] }, /après startDate/],
    ['plage avec une clé mal écrite', { relevantDates: [{ start: '2026-12-31T23:00Z' }] }, /clé inconnue « start »/],
    ['liste de dates vide', { relevantDates: [] }, /liste non vide/],
    ['plus de dix lieux', { locations: Array.from({ length: 11 }, () => ({ latitude: 1, longitude: 1 })) }, /10 au plus/],
    ['latitude hors limites', { locations: [{ latitude: 91, longitude: 0 }] }, /latitude/],
    ['longitude absente', { locations: [{ latitude: 1 }] }, /longitude/],
    ['lieu avec une clé mal écrite', { locations: [{ latitude: 1, longitude: 1, lat: 1 }] }, /clé inconnue « lat »/],
    ['distance nulle', { maxDistance: 0 }, /plus grand que 0/],
    ['balise sans UUID', { beacons: [{ proximityUUID: 'abc' }] }, /UUID/],
    ['balise major trop grand', { beacons: [{ proximityUUID: 'E2C56DB5-DFFB-48D2-B060-D0F5A71096E0', major: 70000 }] }, /major/],
    ['semantics en liste', { semantics: [] }, /étiquettes sémantiques/],
    ['semantics avec NaN', { semantics: { eventName: 'x', totalPrice: { amount: Number.NaN } } }, /nombre invalide/],
    ['userInfo avec une fonction', { userInfo: { rappel: () => 1 } }, /JSON/],
    ['styles vides', { preferredStyleSchemes: [] }, /liste non vide/],
    ['couleur du pied en hexadécimal', { footerBackgroundColor: '#000' }, /rgb\(r, g, b\)/],
    ['lien en ftp', { sellURL: 'ftp://theatre.example' }, /https/],
    ['lien illisible', { transferURL: 'pas une adresse' }, /n'est pas une adresse/],
    ['identifiant d’app non entier', { associatedStoreIdentifiers: [12.5] }, /entier/],
    ['message NFC trop long', { nfc: { message: 'x'.repeat(65), encryptionPublicKey: 'MFkw' } }, /64 octets/],
    ['booléen en texte', { sharingProhibited: 'oui' }, /true ou false/],
    ['texte vide', { groupingIdentifier: ' ' }, /texte non vide/]
  ])('refusé : %s', (_nom, carte, message) => {
    expect(() => billet(carte)).toThrow(message);
  });

  test('un lien d’application peut avoir son propre schéma', () => {
    expect(billet({ appLaunchURL: 'theatre://billet/B-1' }).appLaunchURL).toBe('theatre://billet/B-1');
  });

  test('une date à fuseau d’un seul chiffre (exemple d’Apple) est acceptée', () => {
    expect(billet({ relevantDates: [{ date: '2026-01-02T00:00-7:00' }] }).relevantDates).toEqual([{ date: '2026-01-02T00:00-7:00' }]);
  });
});

describe('extraKeys : les clés qu’Apple ajoutera', () => {
  test('écrites telles quelles, les dates en ISO 8601', () => {
    const pass = billet({ extraKeys: { upcomingPassInformation: [{ date: new Date('2027-01-05T18:00:00Z'), nom: 'Seconde date' }] } });
    expect(pass.upcomingPassInformation).toEqual([{ date: '2027-01-05T18:00:00.000Z', nom: 'Seconde date' }]);
  });

  test.each([
    ['une clé que le paquet écrit', { extraKeys: { serialNumber: 'autre' } }, /ne peut pas remplacer « serialNumber »/],
    ['le style de la carte', { extraKeys: { eventTicket: {} } }, /ne peut pas remplacer « eventTicket »/],
    ['une clé qui a son contrôle', { extraKeys: { locations: [] } }, /se donne directement/],
    ['pas un objet', { extraKeys: ['a'] }, /extraKeys doit être un objet/],
    ['une valeur impossible en JSON', { extraKeys: { infini: Infinity } }, /nombre invalide/]
  ])('refusé : %s', (_nom, carte, message) => {
    expect(() => billet(carte)).toThrow(message);
  });

  test('un extraKeys de fabrique qui n’est pas un objet est refusé aussi', () => {
    expect(() => billet({ extraKeys: { a: 1 } }, { extraKeys: 'a' })).toThrow(/extraKeys doit être un objet/);
  });
});

describe('billets Google Wallet', () => {
  const CLE_GOOGLE = { client_email: 'wallet@test.iam.gserviceaccount.com', private_key: CLE };

  test.each([
    ['eventTicket', 'eventTicketClass', 'eventTicketObjects'],
    ['flight', 'flightClass', 'flightObjects'],
    ['transit', 'transitClass', 'transitObjects']
  ])('%s : sa ressource et sa clé dans le lien d’ajout', async (kind, ressource, cleJwt) => {
    const appels = [];
    const wallet = createGoogleWallet({ issuerId: '3388', credentials: CLE_GOOGLE, kind, request: async (o) => { appels.push(o); return {}; } });
    await wallet.ensureClass({ id: wallet.classId('spectacle') });
    expect(appels[0].url).toMatch(new RegExp(`/v1/${ressource}/3388\\.spectacle$`));
    const jwt = wallet.saveLink([{ id: '3388.B-1', classId: '3388.spectacle' }]).split('/save/')[1];
    const contenu = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    expect(contenu.payload).toEqual({ [cleJwt]: [{ id: '3388.B-1', classId: '3388.spectacle' }] });
  });
});
