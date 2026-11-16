/**
 * La fabrication du .pkpass, sans passkit-generator : l'archive, le
 * manifeste, la signature CMS et l'encodage DER, relus ici par des moyens
 * indépendants du code qui les écrit (zlib pour le CRC, crypto.verify pour la
 * signature, openssl quand il est là).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { createApplePasses } = require('../src');
const der = require('../src/pkpass/der');
const { crc32 } = require('../src/pkpass/zip');

const lire = (nom) => fs.readFileSync(path.join(__dirname, 'fixtures', nom));
const CERT = lire('pass-test.pem').toString();
const CLE = lire('pass-test.key').toString();
const PIXEL = lire('pixel.png');
const JETON = 'jeton-assez-long-pour-apple-123';

function fabrique(options = {}) {
  return createApplePasses({
    certificate: CERT, privateKey: CLE, wwdr: CERT, webServiceURL: 'https://api.test/wallet/apple',
    organizationName: 'Salon Test', description: 'Carte fidélité',
    images: { 'icon.png': PIXEL, 'logo.png': PIXEL }, colors: { backgroundColor: 'rgb(11, 16, 32)' },
    ...options
  });
}

/* Lecteur ZIP minimal : répertoire central, en-têtes locaux, CRC par zlib. */
function lireZip(buffer) {
  const fin = buffer.length - 22;
  expect(buffer.readUInt32LE(fin)).toBe(0x06054b50);
  const nombre = buffer.readUInt16LE(fin + 10);
  let position = buffer.readUInt32LE(fin + 16);
  const fichiers = new Map();
  for (let i = 0; i < nombre; i += 1) {
    expect(buffer.readUInt32LE(position)).toBe(0x02014b50);
    const methode = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const taille = buffer.readUInt32LE(position + 20);
    const longueurNom = buffer.readUInt16LE(position + 28);
    const local = buffer.readUInt32LE(position + 42);
    const nom = buffer.subarray(position + 46, position + 46 + longueurNom).toString('utf8');
    expect(methode).toBe(0);
    expect(buffer.readUInt32LE(local)).toBe(0x04034b50);
    const debut = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const donnees = buffer.subarray(debut, debut + taille);
    expect(zlib.crc32(donnees)).toBe(crc);
    fichiers.set(nom, donnees);
    position += 46 + longueurNom;
  }
  return fichiers;
}

/* Les morceaux de la signature, lus avec le lecteur DER. */
function lireSignature(signature) {
  const racine = der.lire(signature);
  expect(racine.fin).toBe(signature.length);
  const [type, enveloppe] = der.enfants(signature, racine);
  expect(der.brut(signature, type)).toEqual(der.identifiant('1.2.840.113549.1.7.2'));
  const [donnees] = der.enfants(signature, enveloppe);
  const [version, , contenu, certificats, signataires] = der.enfants(signature, donnees);
  const [signataire] = der.enfants(signature, signataires);
  const [, , , attributs, , valeur] = der.enfants(signature, signataire);
  return {
    version: der.brut(signature, version),
    contenuEncapsule: der.enfants(signature, contenu),
    certificats: der.enfants(signature, certificats).map((c) => new crypto.X509Certificate(der.brut(signature, c))),
    attributs: der.brut(signature, attributs),
    attributsLus: der.enfants(signature, attributs).map((a) => der.enfants(signature, a).map((e) => der.brut(signature, e))),
    valeur: signature.subarray(valeur.contenu, valeur.fin)
  };
}

function verifierSignature(signature, contenu, certificat) {
  const lu = lireSignature(signature);
  const attributsCommeSet = Buffer.from(lu.attributs);
  attributsCommeSet[0] = 0x31;
  const empreinte = lu.attributsLus.find(([oid]) => oid.equals(der.identifiant('1.2.840.113549.1.9.4')));
  const attendu = der.ensemble([der.chaineOctets(crypto.createHash('sha256').update(contenu).digest())]);
  return empreinte[1].equals(attendu) && crypto.verify('sha256', attributsCommeSet, certificat.publicKey, lu.valeur);
}

function carte(extra = {}) {
  return fabrique().build({
    serialNumber: 'C-000001',
    authenticationToken: JETON,
    headerFields: [{ key: 'numero', label: '', value: 'C-1' }],
    secondaryFields: [{ key: 'passages', label: 'PASSAGES', value: 3 }],
    backFields: [{ key: 'dos', label: 'Lien', value: 'x', attributedValue: '<a href="https://a.b">x</a>' }],
    barcode: { message: 'Carte C-000001', altText: 'C-000001' },
    images: { 'strip.png': PIXEL },
    ...extra
  });
}

describe('archive et manifeste', () => {
  test('les fichiers attendus, le manifeste en SHA-1 de chacun, sans lui-même ni la signature', () => {
    const fichiers = lireZip(carte());
    expect([...fichiers.keys()]).toEqual(['pass.json', 'icon.png', 'logo.png', 'strip.png', 'manifest.json', 'signature']);
    const manifeste = JSON.parse(fichiers.get('manifest.json'));
    expect(Object.keys(manifeste)).toEqual(['pass.json', 'icon.png', 'logo.png', 'strip.png']);
    for (const [nom, empreinte] of Object.entries(manifeste)) {
      expect(empreinte).toBe(crypto.createHash('sha1').update(fichiers.get(nom)).digest('hex'));
    }
  });

  test('pass.json : identité du certificat, service web, code QR par défaut, les cinq zones', () => {
    const pass = JSON.parse(lireZip(carte()).get('pass.json'));
    expect(pass).toMatchObject({
      formatVersion: 1,
      passTypeIdentifier: 'pass.com.test.fidelite',
      teamIdentifier: 'TEAM123456',
      serialNumber: 'C-000001',
      backgroundColor: 'rgb(11, 16, 32)',
      webServiceURL: 'https://api.test/wallet/apple',
      authenticationToken: JETON,
      barcodes: [{ format: 'PKBarcodeFormatQR', message: 'Carte C-000001', messageEncoding: 'utf-8', altText: 'C-000001' }]
    });
    expect(Object.keys(pass.storeCard)).toEqual(['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields']);
    expect(pass.storeCard.secondaryFields).toEqual([{ key: 'passages', label: 'PASSAGES', value: 3 }]);
    expect(pass.storeCard.backFields[0].attributedValue).toBe('<a href="https://a.b">x</a>');
  });

  test('une image propre à la carte remplace l’image commune du même nom', () => {
    const autre = Buffer.concat([PIXEL, Buffer.from([0])]);
    const fichiers = lireZip(carte({ images: { 'logo.png': autre } }));
    expect(fichiers.get('logo.png').equals(autre)).toBe(true);
  });

  test('une carte fixe (sans service web) n’écrit ni adresse ni jeton', () => {
    const buffer = fabrique({ webServiceURL: undefined }).build({ serialNumber: 'S-1', authenticationToken: undefined });
    const pass = JSON.parse(lireZip(buffer).get('pass.json'));
    expect(pass).not.toHaveProperty('webServiceURL');
    expect(pass).not.toHaveProperty('authenticationToken');
    expect(pass).not.toHaveProperty('barcodes');
  });

  test('type et format de code choisis', () => {
    const buffer = fabrique({ type: 'coupon' }).build({ serialNumber: 'K-1', authenticationToken: JETON, barcode: { message: 'K-1', format: 'PKBarcodeFormatPDF417' } });
    const pass = JSON.parse(lireZip(buffer).get('pass.json'));
    expect(pass.coupon).toBeDefined();
    expect(pass.storeCard).toBeUndefined();
    expect(pass.barcodes[0].format).toBe('PKBarcodeFormatPDF417');
  });

  test('un nom de fichier non ASCII voyage en UTF-8', () => {
    const fichiers = lireZip(carte({ images: { 'fr.lproj/étiquette.png': PIXEL } }));
    expect(fichiers.has('fr.lproj/étiquette.png')).toBe(true);
  });
});

describe('signature', () => {
  test('détachée, vérifiable avec la clé publique du certificat, et portant sur le manifeste', () => {
    const fichiers = lireZip(carte());
    const signature = fichiers.get('signature');
    const lu = lireSignature(signature);
    expect(lu.version).toEqual(Buffer.from([0x02, 0x01, 0x01]));
    expect(lu.contenuEncapsule).toHaveLength(1);
    const certificat = new crypto.X509Certificate(CERT);
    expect(lu.certificats.map((c) => c.fingerprint256)).toEqual([certificat.fingerprint256]);
    expect(verifierSignature(signature, fichiers.get('manifest.json'), certificat)).toBe(true);
  });

  test('un manifeste modifié ne correspond plus à la signature', () => {
    const fichiers = lireZip(carte());
    const falsifie = Buffer.concat([fichiers.get('manifest.json'), Buffer.from(' ')]);
    expect(verifierSignature(fichiers.get('signature'), falsifie, new crypto.X509Certificate(CERT))).toBe(false);
  });

  test.each([undefined, null, ''])('le certificat intermédiaire WWDR d’Apple est joint par défaut (wwdr %p)', (wwdr) => {
    const fichiers = lireZip(fabrique({ wwdr }).build({ serialNumber: 'C-2', authenticationToken: JETON }));
    const sujets = lireSignature(fichiers.get('signature')).certificats.map((c) => c.subject);
    expect(sujets).toHaveLength(2);
    expect(sujets.some((s) => s.includes('Worldwide Developer Relations'))).toBe(true);
  });

  test('clé chiffrée : la phrase secrète est utilisée', () => {
    const chiffree = crypto.createPrivateKey(CLE).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'phrase-secrete' });
    const fichiers = lireZip(fabrique({ privateKey: chiffree, passphrase: 'phrase-secrete' }).build({ serialNumber: 'C-3', authenticationToken: JETON }));
    expect(verifierSignature(fichiers.get('signature'), fichiers.get('manifest.json'), new crypto.X509Certificate(CERT))).toBe(true);
  });

  test('openssl accepte la signature (quand openssl est installé)', () => {
    let present = true;
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      present = false;
    }
    if (!present) return;
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'pkpass-'));
    try {
      const fichiers = lireZip(carte());
      fs.writeFileSync(path.join(dossier, 'signature'), fichiers.get('signature'));
      fs.writeFileSync(path.join(dossier, 'manifest.json'), fichiers.get('manifest.json'));
      fs.writeFileSync(path.join(dossier, 'ca.pem'), CERT);
      const verifier = (contenu) => execFileSync('openssl', [
        'smime', '-verify', '-binary', '-inform', 'DER', '-in', 'signature', '-content', contenu,
        '-CAfile', 'ca.pem', '-purpose', 'any', '-out', os.devNull
      ], { cwd: dossier, stdio: 'pipe' });
      expect(() => verifier('manifest.json')).not.toThrow();
      fs.writeFileSync(path.join(dossier, 'falsifie.json'), Buffer.concat([fichiers.get('manifest.json'), Buffer.from(' ')]));
      expect(() => verifier('falsifie.json')).toThrow();
    } finally {
      fs.rmSync(dossier, { recursive: true, force: true });
    }
  });
});

/* Un certificat EC autosigné, fabriqué ici avec l'encodeur DER : aucune clé
   privée de plus n'est versionnée. */
function certificatEc() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const nomRelatif = (oid, texte) => der.ensemble([der.sequence(der.identifiant(oid), der.tlv(0x0c, Buffer.from(texte)))]);
  const nom = der.sequence(
    nomRelatif('0.9.2342.19200300.100.1.1', 'pass.com.test.ec'),
    nomRelatif('2.5.4.11', 'TEAMEC1234'),
    nomRelatif('2.5.4.3', 'Pass Type ID: pass.com.test.ec')
  );
  const algorithme = der.sequence(der.identifiant('1.2.840.10045.4.3.2'));
  const corps = der.sequence(
    der.explicite(0, der.entier(2)),
    der.entier(4242),
    algorithme,
    nom,
    der.sequence(der.temps(new Date('2026-01-01T00:00:00Z')), der.temps(new Date('2046-01-01T00:00:00Z'))),
    nom,
    publicKey.export({ type: 'spki', format: 'der' })
  );
  const signature = crypto.sign('sha256', corps, privateKey);
  const certificat = der.sequence(corps, algorithme, der.tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const pem = `-----BEGIN CERTIFICATE-----\n${certificat.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { pem, cle: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

test('une clé EC signe aussi (ecdsa-with-SHA256)', () => {
  const { pem, cle } = certificatEc();
  const passes = fabrique({ certificate: pem, privateKey: cle, wwdr: pem });
  expect(passes).toMatchObject({ passTypeIdentifier: 'pass.com.test.ec', teamIdentifier: 'TEAMEC1234' });
  const fichiers = lireZip(passes.build({ serialNumber: 'E-1', authenticationToken: JETON }));
  expect(verifierSignature(fichiers.get('signature'), fichiers.get('manifest.json'), new crypto.X509Certificate(pem))).toBe(true);
});

describe('encodage DER et CRC', () => {
  test('longueurs courtes et longues', () => {
    expect(der.tlv(0x04, Buffer.alloc(127)).subarray(0, 2)).toEqual(Buffer.from([0x04, 0x7f]));
    expect(der.tlv(0x04, Buffer.alloc(200)).subarray(0, 3)).toEqual(Buffer.from([0x04, 0x81, 0xc8]));
    expect(der.tlv(0x04, Buffer.alloc(300)).subarray(0, 4)).toEqual(Buffer.from([0x04, 0x82, 0x01, 0x2c]));
  });

  test('entiers : zéro, octet de signe, refus des négatifs', () => {
    expect(der.entier(0)).toEqual(Buffer.from([0x02, 0x01, 0x00]));
    expect(der.entier(127)).toEqual(Buffer.from([0x02, 0x01, 0x7f]));
    expect(der.entier(128)).toEqual(Buffer.from([0x02, 0x02, 0x00, 0x80]));
    expect(der.entier(256)).toEqual(Buffer.from([0x02, 0x02, 0x01, 0x00]));
    expect(() => der.entier(-1)).toThrow(RangeError);
    expect(() => der.entier(1.5)).toThrow(RangeError);
  });

  test('identifiants d’objets', () => {
    expect(der.identifiant('1.2.840.113549')).toEqual(Buffer.from([0x06, 0x06, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d]));
    expect(der.identifiant('2.16.840.1.101.3.4.2.1').toString('hex')).toBe('0609608648016503040201');
    expect(() => der.identifiant('1')).toThrow(RangeError);
    expect(() => der.identifiant('1.x')).toThrow(RangeError);
  });

  test('UTCTime jusqu’en 2049, GeneralizedTime ensuite', () => {
    expect(der.temps(new Date('2049-12-31T23:59:59Z')).toString('latin1', 2)).toBe('491231235959Z');
    expect(der.temps(new Date('2049-12-31T23:59:59Z'))[0]).toBe(0x17);
    expect(der.temps(new Date('2050-01-01T00:00:00Z'))[0]).toBe(0x18);
    expect(der.temps(new Date('2050-01-01T00:00:00Z')).toString('latin1', 2)).toBe('20500101000000Z');
    expect(() => der.temps(new Date('pas une date'))).toThrow(RangeError);
  });

  test('un SET OF est trié, le plus court complété par des zéros', () => {
    const a = Buffer.from([0x04, 0x01, 0x02]);
    const b = Buffer.from([0x04, 0x01, 0x01]);
    const c = Buffer.from([0x04, 0x02, 0x01, 0x00]);
    expect(der.ensemble([c, a, b])).toEqual(Buffer.concat([Buffer.from([0x31, 0x0a]), b, a, c]));
  });

  test('le lecteur refuse ce qui déborde, les longueurs indéfinies et les étiquettes longues', () => {
    expect(() => der.lire(Buffer.from([0x30, 0x05, 0x00]))).toThrow(/tronqué/);
    expect(() => der.lire(Buffer.from([0x30, 0x80, 0x00, 0x00]))).toThrow(/Longueur/);
    expect(() => der.lire(Buffer.from([0x30, 0x85, 1, 1, 1, 1, 1]))).toThrow(/Longueur/);
    expect(() => der.lire(Buffer.from([0x1f, 0x01, 0x00]))).toThrow(/longue/);
    expect(() => der.lire(Buffer.from([0x30]))).toThrow(/tronqué/);
    expect(() => der.emetteurEtNumero(Buffer.from([0x30, 0x00]))).toThrow(/invalide/);
  });

  test('CRC-32 : valeur de contrôle standard et accord avec zlib', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(PIXEL)).toBe(zlib.crc32(PIXEL));
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});
