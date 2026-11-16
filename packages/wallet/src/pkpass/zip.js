/* Archive ZIP sans compression (méthode « stored »), le contenant d'un
   .pkpass. Les images d'une carte sont des PNG, déjà compressés, et Apple
   accepte les deux méthodes : compresser n'apporterait presque rien. */

const TABLE_CRC = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE_CRC[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const octet of buffer) crc = TABLE_CRC[(crc ^ octet) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* Date et heure au format MS-DOS (à deux secondes près, de 1980 à 2107). */
function dateDos(date) {
  const annee = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    heure: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    jour: ((annee - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  };
}

const VERSION = 20;
const NOMS_UTF8 = 0x0800;
const MAX_32 = 0xffffffff;

/**
 * @param {Array<{name: string, data: Buffer}>} fichiers
 * @param {Date} [date]
 * @returns {Buffer}
 */
function creerZip(fichiers, date = new Date()) {
  if (fichiers.length > 0xffff) throw new RangeError('Trop de fichiers pour une archive ZIP sans ZIP64.');
  const { heure, jour } = dateDos(date);
  const locaux = [];
  const centraux = [];
  let position = 0;

  for (const { name, data } of fichiers) {
    const nom = Buffer.from(name, 'utf8');
    if (nom.length > 0xffff) throw new RangeError(`Nom de fichier trop long : ${name}`);
    if (data.length >= MAX_32 || position >= MAX_32) throw new RangeError('Archive trop grande pour un ZIP sans ZIP64.');
    const crc = crc32(data);

    const entete = Buffer.alloc(30);
    entete.writeUInt32LE(0x04034b50, 0);
    entete.writeUInt16LE(VERSION, 4);
    entete.writeUInt16LE(NOMS_UTF8, 6);
    entete.writeUInt16LE(0, 8);
    entete.writeUInt16LE(heure, 10);
    entete.writeUInt16LE(jour, 12);
    entete.writeUInt32LE(crc, 14);
    entete.writeUInt32LE(data.length, 18);
    entete.writeUInt32LE(data.length, 22);
    entete.writeUInt16LE(nom.length, 26);
    entete.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(NOMS_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(heure, 12);
    central.writeUInt16LE(jour, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nom.length, 28);
    central.writeUInt32LE(position, 42);

    locaux.push(entete, nom, data);
    centraux.push(central, nom);
    position += entete.length + nom.length + data.length;
  }

  const repertoire = Buffer.concat(centraux);
  if (position + repertoire.length >= MAX_32) throw new RangeError('Archive trop grande pour un ZIP sans ZIP64.');
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(fichiers.length, 8);
  fin.writeUInt16LE(fichiers.length, 10);
  fin.writeUInt32LE(repertoire.length, 12);
  fin.writeUInt32LE(position, 16);
  return Buffer.concat([...locaux, repertoire, fin]);
}

module.exports = { creerZip, crc32 };
