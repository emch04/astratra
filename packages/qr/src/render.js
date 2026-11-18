const { createQr, QrError } = require('./qr');

/*
 * Le rendu d'un code QR : SVG (net à toute taille, utilisable dans un navigateur), PNG (Node, par node:zlib) et
 * adresse data:. Les couleurs sont vérifiées avant d'entrer dans le SVG : une couleur piégée (« red\"/><script> »)
 * ne peut pas y glisser de code.
 */

const SAFE_SVG_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,30}|(rgb|rgba|hsl|hsla)\([0-9.,%\s]{1,60}\))$/;
const qrOf = (input, options) => (typeof input === 'string' ? createQr(input, options) : input);

function checkMargin(margin) {
  if (!Number.isInteger(margin) || margin < 0 || margin > 64) throw new QrError('margin must be an integer between 0 and 64');
  return margin;
}

/** Le SVG du code (un chemin par rangée de modules contigus). `input` : un texte ou le résultat de createQr. */
function qrToSvg(input, { margin = 4, dark = '#000000', light = '#ffffff', width, title, ...options } = {}) {
  const qr = qrOf(input, options);
  checkMargin(margin);
  for (const [name, color] of [['dark', dark], ['light', light]]) {
    if (color !== null && color !== 'transparent' && !SAFE_SVG_COLOR.test(String(color))) throw new QrError(`${name} is not a color`);
  }
  if (width !== undefined && !(Number.isInteger(width) && width > 0 && width <= 10_000)) throw new QrError('width must be a positive integer');
  const full = qr.size + margin * 2;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; ) {
      if (!qr.modules.get(y, x)) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < qr.size && qr.modules.get(y, x + run)) run++;
      path += `M${x + margin} ${y + margin}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const size = width ? ` width="${width}" height="${width}"` : '';
  const background = light && light !== 'transparent' ? `<rect width="${full}" height="${full}" fill="${light}"/>` : '';
  const label = title ? `<title>${escape(title)}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}"${size} shape-rendering="crispEdges" role="img">${label}${background}<path fill="${dark}" d="${path}"/></svg>`;
}

/** « #rgb », « #rrggbb » ou « #rrggbbaa » en [r, g, b, a]. */
function parseHexColor(color, name) {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(String(color));
  if (!match) throw new QrError(`${name} must be a hex color (#rgb, #rrggbb or #rrggbbaa) for a PNG`);
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length === 6) hex += 'ff';
  return [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** Le PNG du code (Node seulement : node:zlib). `scale` : pixels par module. */
function qrToPng(input, { margin = 4, scale = 8, dark = '#000000', light = '#ffffff', ...options } = {}) {
  const qr = qrOf(input, options);
  checkMargin(margin);
  if (!Number.isInteger(scale) || scale < 1 || scale > 64) throw new QrError('scale must be an integer between 1 and 64');
  // node:zlib n'est chargé qu'ici : le reste du paquet marche dans un navigateur.
  const zlib = require('node:zlib');
  const palette = [parseHexColor(light, 'light'), parseHexColor(dark, 'dark')];
  const side = (qr.size + margin * 2) * scale;
  if (side > 20_000) throw new QrError('image too large (lower scale or margin)');
  const rowBytes = Math.ceil(side / 8);
  const raw = Buffer.alloc((rowBytes + 1) * side);
  for (let py = 0; py < side; py++) {
    const y = Math.floor(py / scale) - margin;
    const offset = py * (rowBytes + 1);
    raw[offset] = 0; // filtre « aucun »
    for (let px = 0; px < side; px++) {
      const x = Math.floor(px / scale) - margin;
      const isDark = y >= 0 && y < qr.size && x >= 0 && x < qr.size && qr.modules.get(y, x);
      if (isDark) raw[offset + 1 + (px >> 3)] |= 0x80 >> (px & 7);
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 1; // un bit par pixel
  ihdr[9] = 3; // palette
  const transparent = palette.some((c) => c[3] !== 255);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', Buffer.from(palette.flatMap((c) => c.slice(0, 3)))),
    ...(transparent ? [chunk('tRNS', Buffer.from(palette.map((c) => c[3])))] : []),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Une adresse data: (« svg » partout, « png » sous Node). */
function qrToDataUrl(input, { type = 'svg', ...options } = {}) {
  if (type === 'png') return `data:image/png;base64,${qrToPng(input, options).toString('base64')}`;
  if (type !== 'svg') throw new QrError('type must be svg or png');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrToSvg(input, options))}`;
}

module.exports = { qrToSvg, qrToPng, qrToDataUrl };
