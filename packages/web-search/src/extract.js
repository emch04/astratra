/**
 * Le texte principal d'une page HTML, et ce qu'elle dit d'elle-même (titre,
 * langue, adresse canonique, date de publication), sans aucune dépendance.
 *
 * Prudent plutôt que malin : scripts, styles, cadres et commentaires partent
 * d'abord ; puis la zone principale est choisie (<article> le plus long,
 * <main>, role="main", sinon <body>), débarrassée de la navigation, des pieds
 * de page, des encarts et de ce que leurs classes désignent comme accessoire
 * (cookies, partage, publicités, commentaires…). Les blocs deviennent des
 * retours à la ligne. Le texte rendu est celui dans lequel les passages cités
 * sont repérés : une position renvoie toujours à ce texte-là.
 *
 * Le HTML est découpé une seule fois, en temps linéaire (indexOf, aucune
 * expression régulière qui revienne en arrière) : une page piégée de 2 Mo
 * (« <a <a <a … » sans fin de balise) se lit aussi vite qu'une page normale et
 * ne bloque jamais le processus.
 *
 * Un extracteur meilleur (Readability…) se branche par l'option `extract` de
 * createWebSearch ; il doit rendre au moins `{ text }`.
 */

const { decodeEntities, plainText } = require('./text');
const { parseDate } = require('./dates');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/* Leur contenu est du texte brut jusqu'à la balise de fin (pas de balises dedans). */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
/* Jamais du texte à lire. */
const DROP_ALWAYS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'canvas', 'video', 'audio', 'select', 'textarea', 'head', 'title']);
const BOILERPLATE_TAGS = new Set(['nav', 'footer', 'aside', 'menu', 'dialog', 'form']);
const BOILERPLATE_HINT = /(^|[\s_-])(cookie|consent|gdpr|newsletter|subscribe|share|sharing|social|related|recommend|comment|comments|advert|advertisement|ads?|promo|sponsor|breadcrumbs?|sidebar|menu|navbar|nav|footer|masthead|banner|popup|modal|signup|paywall)([\s_-]|$)/i;
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'blockquote', 'pre', 'figure', 'figcaption', 'address', 'details', 'summary', 'hr', 'br']);
const MAX_TAG_ATTRIBUTES = 8_192;

/**
 * Découpe le HTML en jetons, en une passe : texte, balise (ouvrante ou fermante)
 * ou contenu brut (script, style…). Les commentaires et déclarations disparaissent ;
 * une balise jamais fermée (pas de « > ») arrête la lecture là.
 */
function tokenize(html) {
  const tokens = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      tokens.push({ type: 'text', start: i, end: n });
      break;
    }
    if (lt > i) tokens.push({ type: 'text', start: i, end: lt });
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    const next = html.charCodeAt(lt + 1);
    const isLetter = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const closing = next === 47; // '/'
    if (next === 33 || next === 63) { // '<!' ou '<?'
      const gt = html.indexOf('>', lt + 2);
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }
    if (!isLetter(closing ? html.charCodeAt(lt + 2) : next)) {
      tokens.push({ type: 'text', start: lt, end: lt + 1 });
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) break;
    const head = html.slice(lt + (closing ? 2 : 1), Math.min(gt, lt + 80));
    const name = (/^[a-zA-Z][\w-]*/.exec(head) || [''])[0].toLowerCase();
    const raw = html.slice(lt, Math.min(gt + 1, lt + MAX_TAG_ATTRIBUTES));
    const selfClosing = html.charCodeAt(gt - 1) === 47;
    tokens.push({ type: 'tag', name, closing, selfClosing, raw, start: lt, end: gt + 1 });
    i = gt + 1;
    if (!closing && !selfClosing && RAW_TEXT.has(name)) {
      const finder = new RegExp(`</${name}[\\s/>]`, 'gi');
      finder.lastIndex = i;
      const found = finder.exec(html);
      const stop = found ? found.index : n;
      tokens.push({ type: 'raw', name, start: i, end: stop });
      if (!found) break;
      const gtClose = html.indexOf('>', stop);
      tokens.push({ type: 'tag', name, closing: true, selfClosing: false, raw: '', start: stop, end: gtClose === -1 ? n : gtClose + 1 });
      if (gtClose === -1) break;
      i = gtClose + 1;
    }
  }
  return tokens;
}

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? '') : null;
}

const opens = (token) => token.type === 'tag' && !token.closing && !token.selfClosing && !VOID.has(token.name);

/** Les jetons sans les éléments que `drop(name, rawTag)` désigne, contenu compris. */
function dropTokens(tokens, drop) {
  const out = [];
  let skipping = null;
  let depth = 0;
  for (const token of tokens) {
    if (skipping) {
      if (token.type === 'tag' && token.name === skipping && !token.selfClosing && !VOID.has(token.name)) depth += token.closing ? -1 : 1;
      if (depth === 0) skipping = null;
      continue;
    }
    if (opens(token) && drop(token.name, token.raw)) {
      skipping = token.name;
      depth = 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

/** Le contenu (en jetons) de chaque élément de premier niveau que `test` désigne. */
function elementsIn(tokens, test) {
  const found = [];
  let open = null;
  let depth = 0;
  let start = 0;
  tokens.forEach((token, index) => {
    if (token.type !== 'tag' || token.selfClosing || VOID.has(token.name)) return;
    if (open) {
      if (token.name === open) depth += token.closing ? -1 : 1;
      if (depth === 0) {
        found.push(tokens.slice(start, index));
        open = null;
      }
    } else if (!token.closing && test(token.name, token.raw)) {
      open = token.name;
      depth = 1;
      start = index + 1;
    }
  });
  if (open) found.push(tokens.slice(start));
  return found;
}

function isBoilerplate(name, tag) {
  if (BOILERPLATE_TAGS.has(name)) return true;
  if (name === 'header' && !/\bclass\s*=\s*["'][^"']*(entry|article|post)-?header/i.test(tag)) return true;
  const role = attribute(tag, 'role');
  if (role && /^(navigation|banner|contentinfo|complementary|search|dialog|alert)$/i.test(role)) return true;
  if (/\s(hidden|aria-hidden\s*=\s*["']?true)/i.test(tag)) return true;
  const hint = `${attribute(tag, 'class') || ''} ${attribute(tag, 'id') || ''}`;
  return BOILERPLATE_HINT.test(hint);
}

/** Jetons → texte : blocs en lignes, entités décodées, espaces resserrés ligne par ligne. */
function textOf(html, tokens) {
  let out = '';
  for (const token of tokens) {
    if (token.type === 'text') out += html.slice(token.start, token.end);
    else if (token.type === 'tag') {
      if (token.name === 'li' && !token.closing) out += '\n- ';
      else if (BLOCK_TAGS.has(token.name)) out += '\n';
      else if (token.closing && (token.name === 'td' || token.name === 'th')) out += ' ';
    }
  }
  return decodeEntities(out)
    // eslint-disable-next-line no-control-regex -- les caractères de contrôle sont justement ceux qu'on retire
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u2000-\u200b\u3000]+/g, ' ').trim())
    .filter((line) => line !== '-')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Le HTML sans les éléments que `drop(name, rawTag)` désigne (balises et contenu). */
function removeElements(html, drop) {
  const source = String(html ?? '');
  return dropTokens(tokenize(source), drop).map((token) => source.slice(token.start, token.end)).join('');
}

/** HTML → texte lisible (sans choisir de zone principale). */
function toText(html) {
  const source = String(html ?? '');
  return textOf(source, dropTokens(tokenize(source), (name) => DROP_ALWAYS.has(name)));
}

/**
 * @param {string} html
 * @param {{ url?: string, now?: number }} [options]
 * @returns {{ title: string, text: string, lang: string|null, canonical: string|null, publishedAt: string|null,
 *   modifiedAt: string|null, description: string|null, siteName: string|null }}
 */
function extractPage(html, { url, now } = {}) {
  const source = String(html ?? '');
  const tokens = tokenize(source);

  const meta = new Map();
  let canonical = null;
  let lang = null;
  let titleText = '';
  let timeValue = null;
  const ld = { published: null, modified: null, headline: null };
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) return node.forEach((child) => visit(child, depth + 1));
    if (!ld.published && typeof node.datePublished === 'string') ld.published = node.datePublished;
    if (!ld.modified && typeof node.dateModified === 'string') ld.modified = node.dateModified;
    if (!ld.headline && typeof node.headline === 'string') ld.headline = node.headline;
    if (node['@graph']) visit(node['@graph'], depth + 1);
  };
  tokens.forEach((token, index) => {
    if (token.type === 'tag' && !token.closing) {
      if (token.name === 'meta') {
        const key = (attribute(token.raw, 'property') || attribute(token.raw, 'name') || attribute(token.raw, 'itemprop') || '').toLowerCase();
        const content = attribute(token.raw, 'content');
        if (key && content && !meta.has(key)) meta.set(key, content.trim());
      } else if (token.name === 'link' && !canonical && /\brel\s*=\s*["']?canonical\b/i.test(token.raw)) {
        const href = attribute(token.raw, 'href');
        try {
          canonical = href ? new URL(href, url).href : null;
        } catch (_error) {
          canonical = null;
        }
      } else if (token.name === 'html' && !lang) {
        lang = attribute(token.raw, 'lang');
      } else if (token.name === 'time' && !timeValue) {
        timeValue = attribute(token.raw, 'datetime');
      }
    } else if (token.type === 'raw') {
      const opening = tokens[index - 1];
      const body = source.slice(token.start, token.end);
      if (token.name === 'title' && !titleText) titleText = body;
      if (token.name === 'script' && opening && /application\/ld\+json/i.test(opening.raw) && body.length < 500_000) {
        try {
          visit(JSON.parse(body.trim()), 0);
        } catch (_error) {
          /* un bloc illisible ne dit rien */
        }
      }
    }
  });

  const title = plainText(meta.get('og:title') || ld.headline || titleText || '');
  const published = meta.get('article:published_time') || ld.published || meta.get('datepublished') || meta.get('date')
    || meta.get('dc.date') || meta.get('dc.date.issued') || meta.get('pubdate') || meta.get('publish-date') || timeValue;
  const modified = meta.get('article:modified_time') || ld.modified || meta.get('datemodified') || null;

  const cleaned = dropTokens(tokens, (name) => DROP_ALWAYS.has(name));
  const [inBody] = elementsIn(cleaned, (name) => name === 'body');
  const body = inBody || cleaned;
  const regions = [
    ...elementsIn(body, (name) => name === 'article'),
    ...elementsIn(body, (name) => name === 'main'),
    ...elementsIn(body, (_name, raw) => /^main$/i.test(attribute(raw, 'role') || ''))
  ].map((part) => textOf(source, dropTokens(part, isBoilerplate)));
  const whole = textOf(source, dropTokens(body, isBoilerplate));
  const best = regions.sort((a, b) => b.length - a.length)[0] || '';
  /* Une zone principale trop maigre (un <article> d'aperçu) ne vaut pas le corps entier. */
  const text = best.length >= 200 || best.length >= whole.length * 0.5 ? best : whole;

  return {
    title,
    text,
    lang: lang ? String(lang).trim().slice(0, 35) : (meta.get('og:locale') || null),
    canonical,
    publishedAt: parseDate(published, { now }),
    modifiedAt: parseDate(modified, { now }),
    description: meta.get('og:description') || meta.get('description') || null,
    siteName: meta.get('og:site_name') || null
  };
}

module.exports = { extractPage, removeElements, toText };
