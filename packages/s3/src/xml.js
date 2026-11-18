/*
 * Un lecteur XML minimal pour les réponses de S3 (listes, erreurs, suppressions groupées). Il ne lit que des éléments
 * et du texte : aucun DOCTYPE, aucune entité déclarée (pas d'attaque XXE, pas de « milliard de rires »), une taille et
 * une profondeur bornées. Les cinq entités prédéfinies et les références numériques sont décodées ; les attributs
 * (xmlns) sont ignorés.
 */

class XmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlError';
  }
}

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeText(raw) {
  if (!raw.includes('&')) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp < 0) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp);
    if (semi < 0 || semi - amp > 12) throw new XmlError('unterminated entity');
    const name = raw.slice(amp + 1, semi);
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      const digits = name[1] === 'x' || name[1] === 'X' ? name.slice(2) : name.slice(1);
      if (!digits || !/^[0-9a-fA-F]+$/.test(digits) || !Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new XmlError('invalid character reference');
      out += String.fromCodePoint(code);
    } else if (Object.hasOwn(NAMED, name)) {
      out += NAMED[name];
    } else {
      throw new XmlError(`unknown entity &${name.slice(0, 20)};`);
    }
    i = semi + 1;
  }
  return out;
}

const isNameChar = (c) => c !== undefined && !' \t\r\n/>='.includes(c);

/** Lit un document : rend l'élément racine { name, children, text }. */
function parseXml(input, { maxBytes = 1024 * 1024, maxDepth = 32, maxNodes = 200_000 } = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  if (Buffer.byteLength(text) > maxBytes) throw new XmlError('document too large');
  const root = { name: '#document', children: [], text: '' };
  const stack = [root];
  let nodes = 0;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = lt < 0 ? text.slice(i) : text.slice(i, lt);
    if (chunk) {
      if (stack.length === 1) {
        if (chunk.trim()) throw new XmlError('text outside the root element');
      } else stack[stack.length - 1].text += decodeText(chunk);
    }
    if (lt < 0) break;
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError('unterminated declaration');
      i = end + 2;
    } else if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('unterminated comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0 || stack.length === 1) throw new XmlError('misplaced CDATA');
      stack[stack.length - 1].text += text.slice(lt + 9, end);
      i = end + 3;
    } else if (text[lt + 1] === '!') {
      throw new XmlError('DOCTYPE and declarations are refused');
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      if (end < 0) throw new XmlError('unterminated closing tag');
      const name = text.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open === root || open.name !== name) throw new XmlError(`mismatched closing tag </${name.slice(0, 40)}>`);
      i = end + 1;
    } else {
      let j = lt + 1;
      while (isNameChar(text[j])) j++;
      const name = text.slice(lt + 1, j);
      if (!name) throw new XmlError('empty tag name');
      // Les attributs sont sautés en respectant les guillemets (un « > » peut s'y trouver).
      let quote = null;
      while (j < text.length) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j++;
      }
      if (j >= text.length) throw new XmlError('unterminated tag');
      const selfClosing = text[j - 1] === '/';
      if (++nodes > maxNodes) throw new XmlError('too many elements');
      if (stack.length === 1 && root.children.length) throw new XmlError('more than one root element');
      const node = { name, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) {
        if (stack.length > maxDepth) throw new XmlError('document too deep');
        stack.push(node);
      }
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError('unclosed element');
  if (root.children.length !== 1) throw new XmlError('no root element');
  return root.children[0];
}

const child = (node, name) => node.children.find((c) => c.name === name);
const childrenOf = (node, name) => node.children.filter((c) => c.name === name);
const textOf = (node, name) => {
  const found = child(node, name);
  return found ? found.text : undefined;
};

/** Échappe un texte pour un document XML envoyé (suppression groupée). */
const escapeXml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

module.exports = { parseXml, child, childrenOf, textOf, escapeXml, XmlError };
