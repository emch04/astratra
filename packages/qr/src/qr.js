/* global TextEncoder */
/*
 * Le code QR (ISO/IEC 18004), écrit sans dépendance et utilisable dans un navigateur : modes numérique, alphanumérique
 * et octets (UTF-8), les quatre niveaux de correction (L, M, Q, H), les versions 1 à 40, les huit masques avec le choix
 * du meilleur (pénalités de la norme). Le même algorithme que le générateur de référence de Nayuki : comparé module par
 * module à uqr, qui en est une adaptation, sur des vecteurs enregistrés.
 */

const ECC = {
  L: { ordinal: 0, formatBits: 1 },
  M: { ordinal: 1, formatBits: 0 },
  Q: { ordinal: 2, formatBits: 3 },
  H: { ordinal: 3, formatBits: 2 },
};

// Codes de correction par bloc et nombre de blocs, par niveau (L, M, Q, H) et par version (index 1 à 40).
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const MODES = {
  numeric: { bits: 0x1, charCountBits: [10, 12, 14] },
  alphanumeric: { bits: 0x2, charCountBits: [9, 11, 13] },
  byte: { bits: 0x4, charCountBits: [8, 16, 16] },
};
const ALPHANUMERIC_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;
const MAX_INPUT_BYTES = 7089; // le plus grand contenu possible (version 40, niveau L, chiffres)

class QrError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QrError';
  }
}

const charCountBits = (mode, version) => mode.charCountBits[version <= 9 ? 0 : version <= 26 ? 1 : 2];

/** Le texte en un seul segment : le mode le plus compact qui contient tous ses caractères. */
function makeSegment(text) {
  // Un texte vide : aucun segment (comme le générateur de référence), seulement le remplissage.
  if (text === '') return null;
  if (/^[0-9]*$/.test(text)) {
    const bits = [];
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      bits.push([Number(chunk), chunk.length * 3 + 1]);
    }
    return { mode: MODES.numeric, numChars: text.length, bits };
  }
  if ([...text].every((c) => ALPHANUMERIC_CHARSET.includes(c))) {
    const bits = [];
    for (let i = 0; i + 1 < text.length; i += 2) bits.push([ALPHANUMERIC_CHARSET.indexOf(text[i]) * 45 + ALPHANUMERIC_CHARSET.indexOf(text[i + 1]), 11]);
    if (text.length % 2 === 1) bits.push([ALPHANUMERIC_CHARSET.indexOf(text[text.length - 1]), 6]);
    return { mode: MODES.alphanumeric, numChars: text.length, bits };
  }
  const bytes = new TextEncoder().encode(text);
  return { mode: MODES.byte, numChars: bytes.length, bits: Array.from(bytes, (b) => [b, 8]) };
}

function segmentBits(segment, version) {
  if (!segment) return 0;
  const count = charCountBits(segment.mode, version);
  if (segment.numChars >= 1 << count) return Infinity;
  return 4 + count + segment.bits.reduce((sum, [, len]) => sum + len, 0);
}

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version, ecc) => Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version] * NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version];

// Reed-Solomon sur GF(2^8), polynôme 0x11D.
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

function addEccAndInterleave(data, version, ecc) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

function buildMatrix(version, ecc, codewords, forcedMask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (x, y) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const positions = alignmentPositions(version, size);
  const numAlign = positions.length;
  for (let i = 0; i < numAlign; i++) {
    for (let j = 0; j < numAlign; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(positions[i] + dx, positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormatBits = (mask) => {
    const data = (ecc.formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, getBit(bits, i));
    set(8, 7, getBit(bits, 6));
    set(8, 8, getBit(bits, 7));
    set(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, getBit(bits, i));
    set(8, size - 8, true);
  };
  drawFormatBits(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  // Les données, en zigzag de deux colonnes, de bas en haut puis de haut en bas.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (!isFunction[y][x] && invert) modules[y][x] = !modules[y][x];
      }
    }
  };

  const addHistory = (runLength, history) => {
    if (history[0] === 0) runLength += size;
    history.pop();
    history.unshift(runLength);
  };
  const countPatterns = (history) => {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  };
  const terminate = (runColor, runLength, history) => {
    if (runColor) {
      addHistory(runLength, history);
      runLength = 0;
    }
    runLength += size;
    addHistory(runLength, history);
    return countPatterns(history);
  };
  const penalty = () => {
    let result = 0;
    for (const vertical of [false, true]) {
      for (let a = 0; a < size; a++) {
        let runColor = false;
        let run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const dark = vertical ? modules[b][a] : modules[a][b];
          if (dark === runColor) {
            run++;
            if (run === 5) result += PENALTY_N1;
            else if (run > 5) result++;
          } else {
            addHistory(run, history);
            if (!runColor) result += countPatterns(history) * PENALTY_N3;
            runColor = dark;
            run = 1;
          }
        }
        result += terminate(runColor, run, history) * PENALTY_N3;
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) result += PENALTY_N2;
      }
    }
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * PENALTY_N4;
  };

  let mask = forcedMask;
  if (mask === undefined || mask === null || mask === -1) {
    let minPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormatBits(m);
      const p = penalty();
      if (p < minPenalty) {
        mask = m;
        minPenalty = p;
      }
      applyMask(m);
    }
  }
  applyMask(mask);
  drawFormatBits(mask);
  return { size, modules, mask };
}

/**
 * Un code QR pour `text`. Options : ecc ('L', 'M' par défaut, 'Q', 'H'), minVersion / maxVersion (1 à 40), mask (0 à
 * 7, le meilleur par défaut), boostEcc (monter la correction quand la même version le permet).
 * Rend { version, ecc, mask, size, modules: { size, data, get(ligne, colonne) } }.
 */
function createQr(text, { ecc = 'M', minVersion = 1, maxVersion = 40, mask, boostEcc = false } = {}) {
  if (typeof text !== 'string') throw new QrError('createQr needs a string');
  if (!ECC[ecc]) throw new QrError('ecc must be L, M, Q or H');
  if (!Number.isInteger(minVersion) || !Number.isInteger(maxVersion) || minVersion < 1 || maxVersion > 40 || minVersion > maxVersion) throw new QrError('versions must be between 1 and 40');
  if (mask !== undefined && mask !== null && mask !== -1 && !(Number.isInteger(mask) && mask >= 0 && mask <= 7)) throw new QrError('mask must be between 0 and 7');
  if (text.length > MAX_INPUT_BYTES * 2) throw new QrError('data too long for a QR code');
  const segment = makeSegment(text);
  let level = ECC[ecc];
  let version;
  let used;
  for (version = minVersion; ; version++) {
    used = segmentBits(segment, version);
    if (used <= dataCodewords(version, level) * 8) break;
    if (version >= maxVersion) throw new QrError('data too long for a QR code');
  }
  if (boostEcc) for (const name of ['M', 'Q', 'H']) if (used <= dataCodewords(version, ECC[name]) * 8) level = ECC[name];

  const bits = [];
  const append = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  if (segment) {
    append(segment.mode.bits, 4);
    append(segment.numChars, charCountBits(segment.mode, version));
    for (const [value, len] of segment.bits) append(value, len);
  }
  const capacity = dataCodewords(version, level) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));

  const codewords = addEccAndInterleave(data, version, level);
  const built = buildMatrix(version, level, codewords, mask);
  const flat = new Uint8Array(built.size * built.size);
  built.modules.forEach((row, y) => row.forEach((dark, x) => { flat[y * built.size + x] = dark ? 1 : 0; }));
  const eccName = Object.keys(ECC).find((name) => ECC[name] === level);
  return {
    version,
    ecc: eccName,
    mask: built.mask,
    size: built.size,
    modules: { size: built.size, data: flat, get: (row, column) => flat[row * built.size + column] === 1 },
  };
}

module.exports = { createQr, QrError };
