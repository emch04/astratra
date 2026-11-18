/*
 * Le téléversement de fichiers (multipart/form-data, RFC 7578), lu au fil du flux et gardé en mémoire, sans multer ni
 * busboy. Les mêmes usages que multer en mémoire : .single(nom), .array(nom, max), .fields([...]), .none(), .any() ;
 * req.file / req.files { fieldname, originalname, encoding, mimetype, size, buffer } et req.body ; fileFilter ; les
 * mêmes codes d'erreur (LIMIT_FILE_SIZE, LIMIT_FILE_COUNT, LIMIT_UNEXPECTED_FILE…).
 *
 * Différences voulues :
 *   - des limites par défaut (multer n'en avait aucune) : 10 Mio par fichier, 10 fichiers, 100 champs, 1 Mio par champ,
 *     200 parties, 50 Mio au total ;
 *   - un nom de champ « __proto__ », « constructor » ou « prototype » est refusé (pollution de prototype) ;
 *   - le nom du fichier est lu en UTF-8 (filename*= compris), sans caractères de contrôle ; `safeName` en donne une
 *     forme sans chemin, utilisable sur un disque ;
 *   - un corps interrompu, une frontière absente ou des en-têtes trop longs sont des erreurs 400, jamais une attente sans fin.
 * Le type annoncé par le client (`mimetype`) n'est pas une preuve : `detectFileType(buffer)` lit les premiers octets.
 */

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const DEFAULT_LIMITS = {
  fileSize: 10 * 1024 * 1024,
  files: 10,
  fields: 100,
  fieldSize: 1024 * 1024,
  fieldNameSize: 200,
  parts: 200,
  headerSize: 8 * 1024,
  headerPairs: 20,
  totalSize: 50 * 1024 * 1024,
};

const MESSAGES = {
  LIMIT_PART_COUNT: 'Too many parts',
  LIMIT_FILE_SIZE: 'File too large',
  LIMIT_FILE_COUNT: 'Too many files',
  LIMIT_FIELD_KEY: 'Field name too long',
  LIMIT_FIELD_VALUE: 'Field value too long',
  LIMIT_FIELD_COUNT: 'Too many fields',
  LIMIT_UNEXPECTED_FILE: 'Unexpected field',
  LIMIT_TOTAL_SIZE: 'Request body too large',
  MISSING_FIELD_NAME: 'Field name missing',
  FIELD_NAME_FORBIDDEN: 'Field name not allowed',
  MALFORMED: 'Malformed multipart body',
  UNEXPECTED_END: 'Unexpected end of form',
  HEADER_TOO_LARGE: 'Part headers too large',
};

class UploadError extends Error {
  constructor(code, field) {
    super(MESSAGES[code] || code);
    this.name = 'UploadError';
    this.code = code;
    this.field = field;
    this.status = code === 'LIMIT_FILE_SIZE' || code === 'LIMIT_TOTAL_SIZE' ? 413 : 400;
    this.statusCode = this.status;
  }
}

/** La frontière d'un Content-Type multipart/form-data (RFC 2046 : 1 à 70 caractères), ou null. */
function boundaryOf(contentType) {
  if (typeof contentType !== 'string' || !/^multipart\/form-data\s*(;|$)/i.test(contentType)) return null;
  for (const part of contentType.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== 'boundary') continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (value.length >= 1 && value.length <= 70 && /^[0-9A-Za-z'()+_,\-./:=? ]*[0-9A-Za-z'()+_,\-./:=?]$/.test(value)) return value;
    return '';
  }
  return '';
}

/** Les paramètres d'un en-tête (« form-data; name="a"; filename*=UTF-8''%C3%A9.txt »), lus sans expression ambiguë. */
function parseParameters(value) {
  const params = Object.create(null);
  let i = value.indexOf(';');
  const type = (i < 0 ? value : value.slice(0, i)).trim().toLowerCase();
  while (i >= 0 && i < value.length) {
    i += 1;
    while (value[i] === ' ' || value[i] === '\t') i += 1;
    const eq = value.indexOf('=', i);
    if (eq < 0) break;
    const key = value.slice(i, eq).trim().toLowerCase();
    let j = eq + 1;
    let text = '';
    if (value[j] === '"') {
      j += 1;
      // Comme les navigateurs et busboy : la barre oblique inverse est un caractère comme un autre (un nom de fichier
      // Windows « C:\dossier\a.txt »), sauf devant un guillemet.
      while (j < value.length && value[j] !== '"') {
        if (value[j] === '\\' && value[j + 1] === '"') j += 1;
        text += value[j];
        j += 1;
      }
      j += 1;
      // Après une valeur entre guillemets : seulement des espaces, puis « ; » ou la fin.
      while (value[j] === ' ' || value[j] === '\t') j += 1;
      if (j < value.length && value[j] !== ';') throw new UploadError('MALFORMED');
    } else {
      const end = value.indexOf(';', j);
      text = (end < 0 ? value.slice(j) : value.slice(j, end)).trim();
      j = end < 0 ? value.length : end;
    }
    if (key && !(key in params)) params[key] = text;
    i = value.indexOf(';', j);
  }
  return { type, params };
}

/** filename*=UTF-8''… (RFC 5987), sinon filename="…", lu en UTF-8 ; sans caractères de contrôle. */
function fileNameOf(params) {
  let name;
  const extended = params['filename*'];
  if (extended !== undefined) {
    const match = /^([\w!#$%&+^`{}~-]+)'[\w-]*'(.*)$/.exec(extended);
    if (match) {
      try {
        name = match[1].toLowerCase() === 'utf-8' ? decodeURIComponent(match[2]) : Buffer.from(unescape(match[2]), 'latin1').toString('latin1');
      } catch {
        name = undefined;
      }
    }
  }
  if (name === undefined && params.filename !== undefined) name = Buffer.from(params.filename, 'latin1').toString('utf8');
  if (name === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 1024);
}

/** Un nom de fichier sans chemin ni caractère réservé, utilisable sur un disque (« ../../a.php » → « a.php »). */
function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().normalize('NFC');
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) || !cleaned ? `fichier${cleaned ? `-${cleaned}` : ''}` : cleaned;
}

/**
 * Lit un corps multipart depuis le flux `req`. `accept(file)` dit si un fichier est attendu (sinon
 * LIMIT_UNEXPECTED_FILE) ; `filter(file)` (promesse) applique le fileFilter du projet.
 */
function parseMultipart(req, { boundary, limits, accept, filter }) {
  return new Promise((resolve, reject) => {
    const delimiter = Buffer.from(`\r\n--${boundary}`);
    const first = Buffer.from(`--${boundary}`);
    const body = {};
    const files = [];
    let carry = Buffer.alloc(0);
    let state = 'preamble';
    let part = null;
    let parts = 0;
    let fieldCount = 0;
    let fileCount = 0;
    let total = 0;
    let settled = false;
    let pending = Promise.resolve();

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Le reste du corps est lu sans être gardé, jusqu'à la limite totale, pour que la réponse puisse partir ;
      // au-delà, la connexion est coupée.
      let drained = 0;
      req.on('data', (chunk) => {
        drained += chunk.length;
        if (drained > limits.totalSize) req.destroy();
      });
      req.on('error', () => {});
      req.resume();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ body, files });
    };

    const addField = (name, value) => {
      if (Object.prototype.hasOwnProperty.call(body, name)) body[name] = Array.isArray(body[name]) ? [...body[name], value] : [body[name], value];
      else body[name] = value;
    };

    const startPart = (headerText) => {
      parts += 1;
      if (parts > limits.parts) throw new UploadError('LIMIT_PART_COUNT');
      const lines = headerText.split('\r\n').filter(Boolean);
      if (lines.length > limits.headerPairs) throw new UploadError('HEADER_TOO_LARGE');
      const headers = Object.create(null);
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon <= 0) throw new UploadError('MALFORMED');
        // Un nom d'en-tête est un mot permis (RFC 9110, « token ») : pas d'espace, pas d'octet invisible.
        const headerName = line.slice(0, colon);
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) throw new UploadError('MALFORMED');
        // Un en-tête répété (deux Content-Disposition) laisserait deux lectures possibles de la même partie : refusé.
        if (headerName.toLowerCase() in headers) throw new UploadError('MALFORMED');
        headers[headerName.toLowerCase()] = line.slice(colon + 1).trim();
      }
      const disposition = parseParameters(headers['content-disposition'] || '');
      if (disposition.type !== 'form-data') throw new UploadError('MALFORMED');
      const name = disposition.params.name !== undefined ? Buffer.from(disposition.params.name, 'latin1').toString('utf8') : undefined;
      if (!name) throw new UploadError('MISSING_FIELD_NAME');
      if (Buffer.byteLength(name) > limits.fieldNameSize) throw new UploadError('LIMIT_FIELD_KEY', name);
      if (FORBIDDEN_NAMES.has(name)) throw new UploadError('FIELD_NAME_FORBIDDEN', name);
      const filename = fileNameOf(disposition.params);
      if (filename === undefined) {
        fieldCount += 1;
        if (fieldCount > limits.fields) throw new UploadError('LIMIT_FIELD_COUNT', name);
        return { kind: 'field', name, chunks: [], size: 0 };
      }
      // Un nom de fichier vide (un champ de fichier laissé vide par le navigateur) : la partie est ignorée, comme multer.
      if (filename === '') return { kind: 'skip', size: 0 };
      fileCount += 1;
      if (fileCount > limits.files) throw new UploadError('LIMIT_FILE_COUNT', name);
      // Comme multer : le nom sans son chemin (« ../../etc/passwd » → « passwd »), et le type text/plain quand la partie
      // n'en annonce pas de lisible (RFC 7578).
      const baseName = filename.split(/[\\/]/).pop();
      const announced = parseParameters(headers['content-type'] || '').type;
      const file = {
        fieldname: name,
        originalname: baseName,
        safeName: safeFileName(baseName),
        encoding: (headers['content-transfer-encoding'] || '7bit').toLowerCase(),
        mimetype: /^[!#$%&'*+\-.^_`|~0-9a-z]{1,127}\/[!#$%&'*+\-.^_`|~0-9a-z]{1,127}$/.test(announced) ? announced : 'text/plain',
      };
      if (!accept(file)) throw new UploadError('LIMIT_UNEXPECTED_FILE', name);
      return { kind: 'file', file, chunks: [], size: 0, accepted: null };
    };

    const appendData = (data) => {
      if (!data.length || part.kind === 'skip') return;
      part.size += data.length;
      if (part.kind === 'field') {
        if (part.size > limits.fieldSize) throw new UploadError('LIMIT_FIELD_VALUE', part.name);
      } else if (part.size > limits.fileSize) {
        throw new UploadError('LIMIT_FILE_SIZE', part.file.fieldname);
      }
      part.chunks.push(data);
    };

    const endPart = () => {
      if (part.kind === 'skip') {
        part = null;
        return;
      }
      if (part.kind === 'field') {
        addField(part.name, Buffer.concat(part.chunks).toString('utf8'));
      } else {
        const done = part;
        done.file.buffer = Buffer.concat(done.chunks);
        done.file.size = done.file.buffer.length;
        // Le filtre du projet (fileFilter) décide une fois le fichier lu ; un refus sans erreur le laisse de côté.
        pending = pending.then(async () => {
          const keep = await filter(done.file);
          if (keep) files.push(done.file);
        });
      }
      part = null;
    };

    const consume = () => {
      for (;;) {
        if (state === 'preamble') {
          const at = carry.indexOf(first);
          if (at < 0) {
            if (carry.length > limits.headerSize + first.length) throw new UploadError('MALFORMED');
            return;
          }
          carry = carry.subarray(at + first.length);
          state = 'afterBoundary';
        } else if (state === 'afterBoundary') {
          if (carry.length < 2) return;
          if (carry[0] === 0x2d && carry[1] === 0x2d) {
            state = 'done';
            carry = Buffer.alloc(0);
            return;
          }
          // Espaces permis avant la fin de ligne (RFC 2046, « transport padding »).
          const eol = carry.indexOf(CRLF);
          if (eol < 0) {
            if (carry.length > 1024) throw new UploadError('MALFORMED');
            return;
          }
          if (carry.subarray(0, eol).toString('latin1').trim() !== '') throw new UploadError('MALFORMED');
          carry = carry.subarray(eol + 2);
          state = 'headers';
        } else if (state === 'headers') {
          const end = carry.indexOf(HEADER_END);
          const blank = carry.length >= 2 && carry[0] === 0x0d && carry[1] === 0x0a;
          if (blank) {
            part = startPart('');
            carry = carry.subarray(2);
            state = 'body';
            continue;
          }
          if (end < 0) {
            if (carry.length > limits.headerSize) throw new UploadError('HEADER_TOO_LARGE');
            return;
          }
          if (end > limits.headerSize) throw new UploadError('HEADER_TOO_LARGE');
          part = startPart(carry.subarray(0, end).toString('latin1'));
          carry = carry.subarray(end + 4);
          state = 'body';
        } else if (state === 'body') {
          const at = carry.indexOf(delimiter);
          if (at < 0) {
            // Les derniers octets peuvent être le début de la frontière : ils attendent le morceau suivant.
            const keep = Math.min(carry.length, delimiter.length - 1);
            appendData(carry.subarray(0, carry.length - keep));
            carry = Buffer.from(carry.subarray(carry.length - keep));
            return;
          }
          appendData(carry.subarray(0, at));
          endPart();
          carry = carry.subarray(at + delimiter.length);
          state = 'afterBoundary';
        } else {
          // Après la dernière frontière : l'épilogue n'est pas gardé.
          carry = Buffer.alloc(0);
          return;
        }
      }
    };

    function onData(chunk) {
      if (settled) return;
      total += chunk.length;
      if (total > limits.totalSize) return fail(new UploadError('LIMIT_TOTAL_SIZE'));
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      try {
        consume();
      } catch (error) {
        fail(error instanceof UploadError ? error : new UploadError('MALFORMED'));
      }
    }
    function onEnd() {
      if (settled) return;
      if (state !== 'done') return fail(new UploadError(state === 'preamble' && total === 0 ? 'MALFORMED' : 'UNEXPECTED_END'));
      cleanup();
      pending.then(succeed, (error) => fail(error));
    }
    function onError() {
      fail(new UploadError('UNEXPECTED_END'));
    }
    function onAborted() {
      fail(new UploadError('UNEXPECTED_END'));
    }
    function onClose() {
      if (!settled && state !== 'done') fail(new UploadError('UNEXPECTED_END'));
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

/**
 * @param {object} [options]
 * @param {object} [options.limits]   fileSize, files, fields, fieldSize, fieldNameSize, parts, headerSize, headerPairs, totalSize.
 * @param {Function} [options.fileFilter]  (req, file, cb) comme multer, ou (req, file) => booléen / promesse.
 */
function createUpload({ limits: userLimits = {}, fileFilter } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...userLimits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`createUpload: limits.${key} must be a number of zero or more.`);
  }

  const runFilter = (req, file) =>
    new Promise((resolve, reject) => {
      if (!fileFilter) return resolve(true);
      let done = false;
      const cb = (error, keep) => {
        if (done) return;
        done = true;
        if (error) reject(error);
        else resolve(Boolean(keep));
      };
      try {
        const out = fileFilter(req, file, cb);
        if (fileFilter.length < 3) Promise.resolve(out).then((keep) => cb(null, keep), cb);
      } catch (error) {
        cb(error);
      }
    });

  const middleware = (mode, expected) => async (req, res, next) => {
    const boundary = boundaryOf(req.headers && req.headers['content-type']);
    // Pas du multipart : la requête passe telle quelle (comme multer).
    if (boundary === null) return next();
    if (!boundary) return next(new UploadError('MALFORMED'));
    const counts = new Map();
    const accept = (file) => {
      if (mode === 'none') return false;
      if (mode === 'any') return true;
      const max = expected.get(file.fieldname);
      if (max === undefined) return false;
      const seen = (counts.get(file.fieldname) || 0) + 1;
      counts.set(file.fieldname, seen);
      return seen <= max;
    };
    try {
      const { body, files } = await parseMultipart(req, { boundary, limits, accept, filter: (file) => runFilter(req, file) });
      req.body = body;
      if (mode === 'single') req.file = files[0];
      else if (mode === 'fields') {
        req.files = {};
        for (const file of files) (req.files[file.fieldname] ||= []).push(file);
      } else if (mode !== 'none') req.files = files;
      return next();
    } catch (error) {
      return next(error);
    }
  };

  return {
    single: (name) => middleware('single', new Map([[name, 1]])),
    array: (name, maxCount = Infinity) => middleware('array', new Map([[name, maxCount]])),
    fields: (list) => middleware('fields', new Map(list.map(({ name, maxCount = Infinity }) => [name, maxCount]))),
    none: () => middleware('none', new Map()),
    any: () => middleware('any', new Map()),
  };
}

/**
 * Le vrai type d'un fichier, d'après ses premiers octets (le type annoncé par le client n'est pas une preuve). Rend
 * { ext, mime } ou null.
 */
function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const b = buffer;
  const ascii = (start, end) => b.subarray(start, end).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { ext: 'gif', mime: 'image/gif' };
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (ascii(0, 5) === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return { ext: 'avif', mime: 'image/avif' };
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) return { ext: 'heic', mime: 'image/heic' };
    if (brand === 'qt  ') return { ext: 'mov', mime: 'video/quicktime' };
    if (brand.startsWith('M4A')) return { ext: 'm4a', mime: 'audio/mp4' };
    return { ext: 'mp4', mime: 'video/mp4' };
  }
  if (b.readUInt32BE(0) === 0x1a45dfa3) return { ext: 'webm', mime: 'video/webm' };
  if (ascii(0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06)) return { ext: 'zip', mime: 'application/zip' };
  return null;
}

module.exports = { createUpload, detectFileType, safeFileName, UploadError, UPLOAD_DEFAULT_LIMITS: DEFAULT_LIMITS };
