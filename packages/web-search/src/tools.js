/**
 * Brancher la recherche sur un modèle : deux outils, `web_search` et `read_page`.
 *
 * - `toolDefinitions(format)` : les schémas tels que chaque API les attend
 *   (Anthropic, OpenAI, Mistral, Gemini) ;
 * - `nativeTools(ws)` : des outils pour `runToolLoop` de @astratra/ai (genre
 *   `read`, risque LOW), qui rendent `{ data, sources }` : les sources vont au
 *   registre des sources (`createSourceLedger`), en `kind: 'web'`, ce qui
 *   marque la lecture comme non fiable pour `readsUntrusted` ;
 * - `registryTools(ws, { roles })` : les mêmes pour le registre de
 *   `runAgentLoop` (`external: true` : la requête part hors de l'application,
 *   le masque des données personnelles s'applique).
 *
 * `runTool(ws, name, args)` est le cœur commun : il valide les arguments du
 * modèle et rend le texte cadré.
 */

const { formatForModel, formatPageForModel } = require('./format');
const { WebSearchError, CODES } = require('./errors');
const { geminiSchema } = require('@astratra/ai');

const SEARCH_DESCRIPTION = 'Search the web. Returns a numbered list of sources; each source is one page of one site, with its exact url, '
  + 'its date when known and an excerpt of that page only. Cite sources by id ([S1]). Use freshness for recent events, sites to stay on '
  + 'trusted sites. Set read to 1-3 to also get verbatim passages from the top pages.';
const READ_DESCRIPTION = 'Read one web page (https only) and return its main text, its date and verbatim passages. '
  + 'Give quotes to check whether the page really contains them: each quote is reported as found (with its position) or NOT found.';

const SEARCH_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to search for, in the language of the expected pages.' },
    freshness: { type: 'string', enum: ['auto', 'any', 'day', 'week', 'month', 'year'], description: 'Only pages from this period. auto (default) puts recent pages first when the question asks for recent facts.' },
    sites: { type: 'array', items: { type: 'string' }, description: 'Only these sites (example.com).' },
    exclude_sites: { type: 'array', items: { type: 'string' }, description: 'Never these sites.' },
    lang: { type: 'string', description: 'Two-letter language code (fr, en).' },
    country: { type: 'string', description: 'Two-letter country code (fr, us).' },
    limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of sources (default 6).' },
    read: { type: 'integer', minimum: 0, maximum: 3, description: 'Read the top pages and add verbatim passages (default 0).' }
  },
  required: ['query'],
  additionalProperties: false
});

const READ_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The https address of the page, exactly as given by web_search.' },
    quotes: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Sentences to look for on the page, word for word.' },
    query: { type: 'string', description: 'What you are looking for on the page, to get the best passages.' }
  },
  required: ['url'],
  additionalProperties: false
});

const TOOLS = [
  { name: 'web_search', description: SEARCH_DESCRIPTION, parameters: SEARCH_SCHEMA },
  { name: 'read_page', description: READ_DESCRIPTION, parameters: READ_SCHEMA }
];

/**
 * Les définitions d'outils au format d'une API.
 * @param {'anthropic'|'openai'|'mistral'|'gemini'|'generic'} format
 */
function toolDefinitions(format = 'generic') {
  const copy = (value) => JSON.parse(JSON.stringify(value));
  switch (format) {
    case 'anthropic':
      return TOOLS.map(({ name, description, parameters }) => ({ name, description, input_schema: copy(parameters) }));
    case 'openai':
    case 'mistral':
      return TOOLS.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters: copy(parameters) } }));
    case 'gemini':
      return [{ functionDeclarations: TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters: geminiSchema(copy(parameters)) })) }];
    case 'generic':
      return TOOLS.map(copy);
    default:
      throw new Error(`Unknown tool format ${format}: anthropic, openai, mistral, gemini or generic.`);
  }
}

const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : undefined);

/** Les arguments du modèle, en demande pour ws.search. */
function searchArgs(args = {}, defaults = {}) {
  if (!args || typeof args !== 'object' || typeof args.query !== 'string') throw new WebSearchError(CODES.BAD_REQUEST, 'web_search needs a query string');
  const limit = Number.isInteger(args.limit) ? Math.min(10, Math.max(1, args.limit)) : defaults.limit ?? 6;
  const read = Number.isInteger(args.read) ? Math.min(3, Math.max(0, args.read)) : defaults.read ?? 0;
  return {
    query: args.query,
    ...(typeof args.freshness === 'string' ? { freshness: args.freshness } : {}),
    ...(strings(args.sites) ? { sites: strings(args.sites) } : {}),
    ...(strings(args.exclude_sites) ? { excludeSites: strings(args.exclude_sites) } : {}),
    ...(typeof args.lang === 'string' && args.lang ? { lang: args.lang } : {}),
    ...(typeof args.country === 'string' && args.country ? { country: args.country } : {}),
    limit,
    read
  };
}

/**
 * Exécute un outil pour un modèle.
 * @returns {Promise<{ text: string, sources: object[], found: object }>}
 */
async function runTool(ws, name, args, { signal, defaults, maxChars } = {}) {
  if (name === 'web_search') {
    const found = await ws.search(searchArgs(args, defaults), { signal });
    return {
      text: formatForModel(found, { maxChars }),
      sources: found.results.map((result) => ({
        kind: 'web', id: result.id, url: result.url, title: result.title, domain: result.domain,
        publishedAt: result.publishedAt, excerpt: result.snippet
      })),
      found
    };
  }
  if (name === 'read_page') {
    if (!args || typeof args.url !== 'string') throw new WebSearchError(CODES.BAD_REQUEST, 'read_page needs a url string');
    const page = await ws.read(args.url, { quotes: strings(args.quotes)?.slice(0, 5), query: typeof args.query === 'string' ? args.query : undefined, signal });
    return {
      text: formatPageForModel(page, { maxChars }),
      sources: [{ kind: 'web', url: page.finalUrl, title: page.title, domain: page.domain, publishedAt: page.publishedAt, excerpt: page.passages[0]?.text || page.text.slice(0, 300) }],
      found: page
    };
  }
  throw new WebSearchError(CODES.BAD_REQUEST, `unknown tool ${name}`);
}

/**
 * Pour runToolLoop / createToolCaller de @astratra/ai. Le texte rendu tient dans
 * 5 000 caractères par défaut : createToolCaller coupe à 6 000 (`resultMax`), et
 * une coupe ôterait la marque de fin du cadre. Monter `maxChars` avec `resultMax`.
 */
function nativeTools(ws, options = {}) {
  const maxChars = options.maxChars ?? 5_000;
  return TOOLS.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters: JSON.parse(JSON.stringify(parameters)),
    kind: 'read',
    risk: 'LOW',
    summary: (args = {}) => (name === 'web_search' ? { query: String(args.query ?? '') } : { url: String(args.url ?? '') }),
    run: async (args, ctx = {}) => {
      const { text, sources } = await runTool(ws, name, args, { signal: ctx.signal, defaults: options.defaults, maxChars });
      return { data: text, sources };
    }
  }));
}

/** Pour createToolRegistry / runAgentLoop de @astratra/ai (qui met de côté au-delà de 12 000 caractères). */
function registryTools(ws, { roles, defaults, maxChars = 10_000 } = {}) {
  if (!Array.isArray(roles) || !roles.length) throw new Error('registryTools needs the roles allowed to search.');
  return TOOLS.map(({ name, description, parameters }) => ({
    name,
    description,
    type: 'read',
    risk: 'LOW',
    external: true,
    roles: [...roles],
    params: Object.fromEntries(Object.entries(parameters.properties).map(([key, value]) => [key, `${value.type}${parameters.required.includes(key) ? '' : ', optional'} — ${value.description}`])),
    handler: async (params, ctx = {}) => (await runTool(ws, name, params, { signal: ctx.signal, defaults, maxChars })).text
  }));
}

module.exports = { toolDefinitions, nativeTools, registryTools, runTool, searchArgs, TOOL_SCHEMAS: { web_search: SEARCH_SCHEMA, read_page: READ_SCHEMA } };
