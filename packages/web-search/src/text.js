/**
 * Du texte propre à partir de morceaux de HTML : les entités décodées, les
 * balises retirées, les espaces resserrés. Sert aux extraits des moteurs (Brave
 * met des <strong> dans ses descriptions) et à l'extraction des pages.
 */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', laquo: '«', raquo: '»',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô',
  ucirc: 'û', ugrave: 'ù', icirc: 'î', iuml: 'ï', euml: 'ë', oelig: 'œ', copy: '©', reg: '®',
  trade: '™', euro: '€', deg: '°', middot: '·', bull: '•', times: '×', shy: ''
};

function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    if (NAMED[body] !== undefined) return NAMED[body];
    const named = NAMED[body.toLowerCase()];
    if (named === undefined) return whole;
    /* &Eacute; → É : la majuscule suit celle du nom de l'entité. */
    return /^[A-Z][a-z]+$/.test(body) && /^\p{Ll}$/u.test(named) ? named.toUpperCase() : named;
  });
}

/** Retire les balises en une passe (indexOf) : une balise jamais fermée coupe le reste. */
function stripTags(text) {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt === -1) return out + text.slice(i);
    out += text.slice(i, lt);
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) return out;
    i = gt + 1;
  }
}

/** Une ligne de texte : sans balises, entités décodées, espaces resserrés. */
function plainText(fragment) {
  // eslint-disable-next-line no-control-regex -- les caractères de contrôle sont justement ceux qu'on retire
  return decodeEntities(stripTags(String(fragment ?? ''))).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}

/** Coupe à `max` caractères sur une limite de mot, avec « … » si coupé. */
function clip(text, max) {
  const value = String(text ?? '');
  if (!Number.isFinite(max) || value.length <= max) return value;
  if (max <= 0) return '';
  const cut = value.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

module.exports = { decodeEntities, plainText, stripTags, clip };
