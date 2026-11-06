/**
 * Des passages cités MOT POUR MOT, avec leur position dans le texte de LA page lue.
 *
 * Chaque passage rendu vaut exactement `text.slice(start, end)` : il est
 * découpé dans le texte de la page, jamais réécrit ni recollé avec un autre.
 * `verifyPassage` le revérifie ; une citation qu'on ne retrouve pas est dite
 * absente (`found: false`), jamais rapprochée d'une phrase voisine.
 */

const fold = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const STOP = new Set(('a au aux avec ce ces dans de des du elle en et est il ils je la le les leur lui ma mais me mes mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes ton tu un une vos votre vous y '
  + 'the of and or to in on for is are was were be been by with as at it its this that these those from an not but what which who how why when where do does did can could should would will about into than then there their they them you your we our').split(' '));

/** Le texte ramené à une forme comparable, et pour chaque caractère gardé sa position d'origine. */
function normalizedWithMap(text) {
  let out = '';
  const map = [];
  let lastSpace = true;
  for (let index = 0; index < text.length; index += 1) {
    let char = text[index];
    if (/\s/.test(char)) {
      if (lastSpace) continue;
      out += ' ';
      map.push(index);
      lastSpace = true;
      continue;
    }
    if (char === '’' || char === '‘' || char === 'ʼ') char = "'";
    else if (char === '“' || char === '”' || char === '«' || char === '»') char = '"';
    else if (char === '–' || char === '—') char = '-';
    const folded = fold(char);
    for (const piece of folded) {
      out += piece;
      map.push(index);
    }
    lastSpace = false;
  }
  return { text: out, map };
}

function normalizeQuote(quote) {
  return normalizedWithMap(String(quote)).text.trim();
}

/**
 * Retrouve une citation dans le texte : à l'identique d'abord, puis aux espaces,
 * casse, accents et guillemets près. Le passage rendu est toujours le texte d'origine.
 * @returns {{ quote: string, found: boolean, exact?: boolean, start?: number, end?: number, text?: string }}
 */
function findQuote(text, quote) {
  const source = String(text ?? '');
  const wanted = String(quote ?? '').trim();
  if (!wanted || wanted.length > 2000) return { quote: wanted, found: false };
  const at = source.indexOf(wanted);
  if (at !== -1) return { quote: wanted, found: true, exact: true, start: at, end: at + wanted.length, text: wanted };
  const haystack = normalizedWithMap(source);
  const needle = normalizeQuote(wanted);
  if (!needle) return { quote: wanted, found: false };
  const position = haystack.text.indexOf(needle);
  if (position === -1) return { quote: wanted, found: false };
  const start = haystack.map[position];
  const end = haystack.map[position + needle.length - 1] + 1;
  return { quote: wanted, found: true, exact: false, start, end, text: source.slice(start, end) };
}

/** Vrai si le passage est bien, mot pour mot, à cette place dans ce texte. */
function verifyPassage(text, passage) {
  return Boolean(passage) && Number.isInteger(passage.start) && Number.isInteger(passage.end)
    && passage.start >= 0 && passage.end <= String(text).length && passage.start < passage.end
    && String(text).slice(passage.start, passage.end) === passage.text;
}

function termsOf(query) {
  return [...new Set(fold(String(query ?? '')).split(/[^\p{L}\d]+/u).filter((word) => word.length >= 2 && !STOP.has(word)))];
}

/** Les phrases du texte, avec leur position. */
function sentencesOf(text) {
  const out = [];
  const pattern = /[^\n.!?…]+(?:[.!?…]+["»”')\]]*|\n|$)/g;
  let match;
  while ((match = pattern.exec(text))) {
    if (!match[0]) {
      pattern.lastIndex += 1;
      continue;
    }
    const raw = match[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) out.push({ start: match.index + lead, end: match.index + lead + trimmed.length });
  }
  return out;
}

/**
 * Les passages du texte qui répondent le mieux à la requête : des phrases
 * consécutives, au plus `size` caractères, qui ne se chevauchent pas.
 * @returns {{ text: string, start: number, end: number, score: number }[]}
 */
function bestPassages(text, query, { count = 3, size = 500 } = {}) {
  const source = String(text ?? '');
  const terms = termsOf(query);
  if (!source || !terms.length || count <= 0) return [];
  const sentences = sentencesOf(source);
  const windows = [];
  for (let first = 0; first < sentences.length; first += 1) {
    let last = first;
    while (last + 1 < sentences.length && sentences[last + 1].end - sentences[first].start <= size) last += 1;
    let start = sentences[first].start;
    let end = sentences[last].end;
    if (end - start > size) end = start + size;
    const piece = fold(source.slice(start, end));
    const hits = terms.filter((term) => piece.includes(term)).length;
    if (!hits) continue;
    const score = hits / terms.length + Math.min(0.2, hits / Math.max(20, piece.length / 25));
    windows.push({ start, end, score });
  }
  windows.sort((a, b) => (b.score - a.score) || (a.start - b.start));
  const chosen = [];
  for (const window of windows) {
    if (chosen.length >= count) break;
    if (chosen.some((other) => window.start < other.end && other.start < window.end)) continue;
    chosen.push(window);
  }
  return chosen.map(({ start, end, score }) => ({ text: source.slice(start, end), start, end, score: Math.round(score * 1000) / 1000 }));
}

module.exports = { findQuote, verifyPassage, bestPassages, termsOf };
