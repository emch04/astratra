/**
 * Ce que le modèle lit : les règles de citation HORS du cadre, les pages
 * DANS le cadre des données non fiables (frameUntrusted de @astratra/ai/guards).
 *
 * Chaque source a son identifiant ([S1], [S2]…), son adresse exacte, son site
 * et sa date ; son extrait et ses passages sont sous elle et sous elle seule.
 * Un texte de page qui donnerait des ordres reste du texte entre deux marques
 * qu'il ne peut pas refermer.
 */

const { frameUntrusted } = require('@astratra/ai/guards');
const { clip } = require('./text');

const RULES = [
  'Each source below is ONE page of ONE site. Cite the id of the source of every fact, like [S1].',
  'Never attribute the words of one source to another, and never merge two sources into one claim without citing both.',
  'Passages marked "verbatim" are exact quotes of that page; a snippet is the search engine\'s excerpt of that page.',
  'If the sources do not answer the question, say so instead of guessing.'
].join('\n');

/* En dessous, les règles et le cadre ne tiendraient pas. */
const MIN_CHARS = 1_000;

/**
 * Un passage : « verbatim » seulement s'il est rendu tel quel (JSON garde les
 * retours à la ligne) ; trop long, il est dit raccourci, sans le mot verbatim.
 */
function quoted(passage, max, where) {
  const place = `characters ${passage.start}-${passage.end}${where}`;
  if (passage.text.length <= max) return `verbatim (${place}): ${JSON.stringify(passage.text)}`;
  return `shortened excerpt (${place}, cut at ${max} characters, not verbatim): ${JSON.stringify(clip(passage.text, max))}`;
}

/* Une ligne d'en-tête ne garde ni retour à la ligne ni marque de cadre. */
const line = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * @param {object} found  le résultat de ws.search
 * @param {{ maxChars?: number, snippetChars?: number, passageChars?: number }} [options]
 * @returns {string}
 */
function formatForModel(found, { maxChars: asked = 12_000, snippetChars = 400, passageChars = 600 } = {}) {
  const maxChars = Math.max(MIN_CHARS, asked);
  const results = Array.isArray(found?.results) ? found.results : [];
  const header = `Web search for "${clip(line(found?.query), 200)}" (${line(found?.searchedAt || '').slice(0, 10)}): ${results.length} source${results.length === 1 ? '' : 's'}.`;
  if (!results.length) return `${header}\nNo page was found. Say that the web search found nothing; do not invent sources.`;
  const room = maxChars - header.length - RULES.length - frameUntrusted('', { source: 'web_search' }).length - 2;
  const blocks = [];
  let used = 0;
  for (const result of results) {
    const lines = [`[${result.id}] ${line(result.title)}`, `url: ${result.url}`, `site: ${result.domain}`];
    if (result.publishedAt) lines.push(`published: ${result.publishedAt.slice(0, 10)}${result.dateSource === 'page' ? ' (from the page)' : ''}`);
    else lines.push('published: unknown');
    if (result.snippet) lines.push(`snippet: ${clip(line(result.snippet), snippetChars)}`);
    for (const extra of (result.extraSnippets || []).slice(0, 2)) lines.push(`snippet: ${clip(line(extra), snippetChars)}`);
    if (result.page?.status === 'read') {
      for (const passage of result.page.passages || []) {
        lines.push(quoted(passage, passageChars, ' of the page'));
      }
    } else if (result.page?.status === 'other_site') {
      lines.push('page: redirected to another site, not read');
    } else if (result.page?.status === 'failed') {
      lines.push('page: could not be read');
    }
    const separator = blocks.length ? 2 : 0;
    let block = lines.join('\n');
    if (used + separator + block.length > room) {
      if (blocks.length) break;
      block = clip(block, Math.max(0, room));
    }
    blocks.push(block);
    used += separator + block.length;
  }
  return `${header}\n${RULES}\n${frameUntrusted(blocks.join('\n\n'), { source: 'web_search' })}`;
}

/**
 * Une page lue (ws.read), pour le modèle.
 * @param {object} page
 * @param {{ maxChars?: number }} [options]
 */
function formatPageForModel(page, { maxChars: asked = 8_000 } = {}) {
  const maxChars = Math.max(MIN_CHARS, asked);
  const lines = [`url: ${page.finalUrl}`, `site: ${page.domain}`, `title: ${line(page.title)}`, `published: ${page.publishedAt ? page.publishedAt.slice(0, 10) : 'unknown'}`];
  if (!page.sameSite) lines.push(`note: the address redirected to another site (${page.domain}); this text belongs to that site.`);
  for (const quote of page.quotes || []) {
    lines.push(quote.found
      ? `quote found (characters ${quote.start}-${quote.end}): ${JSON.stringify(quote.text)}`
      : `quote NOT found on this page: "${line(quote.quote)}"`);
  }
  for (const passage of page.passages || []) {
    lines.push(quoted(passage, 1_000, ''));
  }
  const rules = 'This is the text of ONE page. Cite it by its url. A quote marked NOT found must not be presented as said by this page.';
  let head = lines.join('\n');
  const overhead = rules.length + 1 + frameUntrusted('', { source: 'web_page' }).length + '\n\ntext:\n'.length;
  if (overhead + head.length > maxChars) head = clip(head, Math.max(0, maxChars - overhead));
  const body = `${head}\n\ntext:\n${clip(page.text, Math.max(0, maxChars - overhead - head.length))}`;
  return `${rules}\n${frameUntrusted(body, { source: 'web_page' })}`;
}

module.exports = { formatForModel, formatPageForModel, CITATION_RULES: RULES };
