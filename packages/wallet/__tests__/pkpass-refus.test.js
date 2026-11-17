/**
 * Ce que la fabrication refuse : tout ce qu'Apple Wallet refuserait sans rien
 * dire, et ce qui ferait signer avec la mauvaise clé.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createApplePasses } = require('../src');
const { creerZip } = require('../src/pkpass/zip');
const { signerDetache } = require('../src/pkpass/signature');

const lire = (nom) => fs.readFileSync(path.join(__dirname, 'fixtures', nom));
const CERT = lire('pass-test.pem').toString();
const CLE = lire('pass-test.key').toString();
const AUTRE_CLE = lire('autre-cle.key').toString();
const PIXEL = lire('pixel.png');
const JETON = 'jeton-assez-long-pour-apple-123';

const options = (extra = {}) => ({
  certificate: CERT, privateKey: CLE, wwdr: CERT, webServiceURL: 'https://api.test/wallet/apple',
  organizationName: 'Salon Test', description: 'Carte', images: { 'icon.png': PIXEL }, ...extra
});
const construire = (carte, extra) => createApplePasses(options(extra)).build({ serialNumber: 'C-1', authenticationToken: JETON, ...carte });

describe('signataire', () => {
  test('une clé qui n’est pas celle du certificat', () => {
    expect(() => createApplePasses(options({ privateKey: AUTRE_CLE }))).toThrow(/ne correspond pas/);
  });

  test('une clé illisible', () => {
    expect(() => createApplePasses(options({ privateKey: 'pas une clé' }))).toThrow(/illisible/);
  });

  test('une clé chiffrée sans phrase secrète, ou avec la mauvaise', () => {
    const chiffree = crypto.createPrivateKey(CLE).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'bonne' });
    expect(() => createApplePasses(options({ privateKey: chiffree }))).toThrow(/phrase secrète/);
    expect(() => createApplePasses(options({ privateKey: chiffree, passphrase: 'mauvaise' }))).toThrow(/phrase secrète/);
  });

  test('une clé ni RSA ni EC', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    expect(() => signerDetache(Buffer.from('{}'), { certificat: new crypto.X509Certificate(CERT), cle: privateKey }))
      .toThrow(/ed25519 non prise en charge/);
  });

  test('une phrase secrète null ou vide avec une clé en clair est acceptée (lue depuis une base)', () => {
    expect(() => createApplePasses(options({ passphrase: null }))).not.toThrow();
    expect(() => createApplePasses(options({ passphrase: '' }))).not.toThrow();
  });

  test('un certificat intermédiaire illisible', () => {
    expect(() => createApplePasses(options({ wwdr: 'pas un certificat' }))).toThrow(/WWDR/);
  });
});

describe('contenu de la carte', () => {
  test('deux champs avec la même clé, recto, dos et informations confondus', () => {
    expect(() => construire({
      headerFields: [{ key: 'portes', value: '1' }],
      additionalInfoFields: [{ key: 'portes', value: '2' }]
    })).toThrow(/portes.*unique/);
  });

  test('deux champs avec la même clé, recto et dos confondus', () => {
    expect(() => construire({
      headerFields: [{ key: 'telephone', value: '1' }],
      backFields: [{ key: 'telephone', value: '2' }]
    })).toThrow(/telephone.*unique/);
  });

  test.each([
    ['sans clé', { headerFields: [{ value: 'x' }] }, /pas de clé/],
    ['clé vide', { headerFields: [{ key: ' ', value: 'x' }] }, /pas de clé/],
    ['valeur objet', { headerFields: [{ key: 'a', value: { x: 1 } }] }, /valeur/],
    ['valeur absente', { headerFields: [{ key: 'a' }] }, /valeur/],
    ['valeur NaN', { headerFields: [{ key: 'a', value: Number.NaN }] }, /valeur/],
    ['libellé nombre', { headerFields: [{ key: 'a', value: 'x', label: 3 }] }, /libellé/],
    ['champ qui n’est pas un objet', { headerFields: ['a'] }, /pas un objet/],
    ['champ null', { headerFields: [null] }, /pas un objet/],
    ['zone qui n’est pas une liste', { backFields: { key: 'a', value: 'x' } }, /liste/]
  ])('champ refusé : %s', (_nom, carte, message) => {
    expect(() => construire(carte)).toThrow(message);
  });

  test.each([
    ['format inconnu', { message: 'x', format: 'PKBarcodeFormatEAN8' }, /format de code-barres inconnu/],
    ['message vide', { message: '' }, /pas de message/],
    ['message absent', {}, /pas de message/],
    ['altText nombre', { message: 'x', altText: 3 }, /altText/],
    ['texte au lieu d’un objet', 'Carte C-1', /doit être un objet/]
  ])('code-barres refusé : %s', (_nom, barcode, message) => {
    expect(() => construire({ barcode })).toThrow(message);
  });

  test('une zone à null vaut une zone vide, un logoText vide n’est pas écrit', () => {
    const fichiers = construire({ primaryFields: null }, { logoText: '' });
    expect(fichiers.toString('latin1')).toContain('"primaryFields":[]');
    expect(fichiers.toString('latin1')).not.toContain('logoText');
  });

  test('numéro de série absent ou vide', () => {
    expect(() => construire({ serialNumber: undefined })).toThrow(/serialNumber/);
    expect(() => construire({ serialNumber: '  ' })).toThrow(/serialNumber/);
  });

  test('avec un service web, le jeton est obligatoire et fait au moins 16 caractères', () => {
    expect(() => construire({ authenticationToken: undefined })).toThrow(/16 caractères/);
    expect(() => construire({ authenticationToken: 'a'.repeat(15) })).toThrow(/16 caractères/);
    expect(() => construire({ authenticationToken: 'a'.repeat(16) })).not.toThrow();
  });
});

describe('réglages de l’émetteur', () => {
  test.each([
    ['hexadécimal', { backgroundColor: '#0b1020' }, /rgb\(r, g, b\)/],
    ['valeur au-delà de 255', { labelColor: 'rgb(256, 0, 0)' }, /rgb\(r, g, b\)/],
    ['couleur inconnue', { stripColor: 'rgb(0, 0, 0)' }, /couleur inconnue/]
  ])('couleur refusée : %s', (_nom, colors, message) => {
    expect(() => construire({}, { colors })).toThrow(message);
  });

  test('type inconnu', () => {
    expect(() => construire({}, { type: 'membershipCard' })).toThrow(/type inconnu/);
  });

  test('une carte d’embarquement sans transitType', () => {
    expect(() => construire({}, { type: 'boardingPass' })).toThrow(/demande transitType/);
  });

  test('adresse de service web invalide', () => {
    expect(() => construire({}, { webServiceURL: 'pas une adresse' })).toThrow(/n'est pas une adresse/);
    expect(() => construire({}, { webServiceURL: 'ftp://api.test/wallet' })).toThrow(/https/);
  });

  test('nom d’organisation ou description absents', () => {
    expect(() => construire({}, { organizationName: '' })).toThrow(/organizationName/);
    expect(() => construire({}, { description: undefined })).toThrow(/description/);
  });

  test('logoText qui n’est pas un texte', () => {
    expect(() => construire({}, { logoText: 42 })).toThrow(/logoText/);
  });
});

describe('fichiers', () => {
  test('sans icon.png, aucune carte', () => {
    expect(() => construire({}, { images: { 'logo.png': PIXEL } })).toThrow(/icon\.png manque/);
  });

  test('une icône dans une traduction suffit', () => {
    expect(() => construire({}, { images: { 'fr.lproj/icon@2x.png': PIXEL } })).not.toThrow();
  });

  test.each(['pass.json', 'manifest.json', 'signature', 'Manifest.JSON'])('nom réservé : %s', (nom) => {
    expect(() => construire({ images: { [nom]: PIXEL } })).toThrow(/fabriqué par le paquet/);
  });

  test.each(['../icon.png', '/icon.png', 'a\\icon.png', 'a//icon.png', './icon.png', 'fr.lproj/', ''])('chemin refusé : « %s »', (nom) => {
    expect(() => construire({ images: { [nom]: PIXEL } })).toThrow(/nom de fichier refusé/);
  });

  test('un fichier qui n’est pas un Buffer', () => {
    expect(() => construire({ images: { 'strip.png': 'base64…' } })).toThrow(/Buffer/);
  });
});

describe('archive', () => {
  test('plus de 65 535 fichiers demanderait ZIP64', () => {
    const fichiers = Array.from({ length: 0x10000 }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(0) }));
    expect(() => creerZip(fichiers)).toThrow(/ZIP64/);
  });

  test('un nom de plus de 65 535 octets', () => {
    expect(() => creerZip([{ name: 'a'.repeat(0x10000), data: Buffer.alloc(0) }])).toThrow(/trop long/);
  });
});
