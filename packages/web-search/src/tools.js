/**
 * Brancher la recherche sur un modèle : deux outils, `web_search` et `read_page`,
 * plus deux quand le navigateur intégré est branché (`createWebSearch({ browser })`) :
 * `browse_page` (la page rendue, ses liens numérotés, sa capture sur demande) et
 * `search_site` (la recherche interne d'un site, sans clic).
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

const { formatForModel, formatPageForModel, formatBrowsedForModel } = require('./format');
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

const BROWSE_DESCRIPTION = 'Open one web page (https only) in a real browser, after its JavaScript ran, and return the text a person sees, '
  + 'its date, verbatim passages and its links numbered [L1], [L2]… (links of the same site first). To follow a link, call browse_page again with its exact url. '
  + 'Use it for pages that read_page cannot read (built with JavaScript) and to explore a site. Pages refused by their robots.txt are not opened.';
const SITE_SEARCH_DESCRIPTION = "Search inside one website with the site's own search (its OpenSearch description or its search form), "
  + 'and return the results page as a browser shows it, with its links numbered. Give any page of the site. Not for general web search: use web_search.';

const BROWSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The https address of the page, exactly as given by web_search or by a link [Ln].' },
    query: { type: 'string', description: 'What you are looking for on the page, to get the best passages.' },
    quotes: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Sentences to look for on the page, word for word.' }
  },
  required: ['url'],
  additionalProperties: false
});
const SCREENSHOT_PROPERTY = Object.freeze({ type: 'boolean', description: 'Also return a screenshot of the visible part of the page (1280 × 800 at most). Only when the layout or images matter.' });

const SITE_SEARCH_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The https address of any page of the site to search.' },
    query: { type: 'string', description: 'What to search for on that site (200 characters at most).' }
  },
  required: ['url', 'query'],
  additionalProperties: false
});

const TOOLS = [
  { name: 'web_search', description: SEARCH_DESCRIPTION, parameters: SEARCH_SCHEMA },
  { name: 'read_page', description: READ_DESCRIPTION, parameters: READ_SCHEMA }
];
const BROWSER_TOOLS = [
  { name: 'browse_page', description: BROWSE_DESCRIPTION, parameters: BROWSE_SCHEMA },
  { name: 'search_site', description: SITE_SEARCH_DESCRIPTION, parameters: SITE_SEARCH_SCHEMA }
];

/** Les outils offerts : les deux de base, plus ceux du navigateur quand il est là. */
function toolList({ browser = false, screenshots = false } = {}) {
  if (!browser) return TOOLS;
  const browse = screenshots
    ? { ...BROWSER_TOOLS[0], parameters: { ...BROWSE_SCHEMA, properties: { ...BROWSE_SCHEMA.properties, screenshot: SCREENSHOT_PROPERTY } } }
    : BROWSER_TOOLS[0];
  return [...TOOLS, browse, BROWSER_TOOLS[1]];
}

/** Les options d'outils d'une recherche : le navigateur est offert s'il est branché. */
const toolOptions = (ws, options = {}) => ({ browser: Boolean(ws?.hasBrowser) && options.browser !== false, screenshots: options.screenshots === true });

/**
 * Les définitions d'outils au format d'une API.
 * @param {'anthropic'|'openai'|'mistral'|'gemini'|'generic'} format
 * @param {{ browser?: boolean, screenshots?: boolean }} [options]  browser : ajouter browse_page et search_site ;
 *        screenshots : le modèle lit les images (paramètre screenshot de browse_page).
 */
function toolDefinitions(format = 'generic', options = {}) {
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const offered = toolList(options);
  switch (format) {
    case 'anthropic':
      return offered.map(({ name, description, parameters }) => ({ name, description, input_schema: copy(parameters) }));
    case 'openai':
    case 'mistral':
      return offered.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters: copy(parameters) } }));
    case 'gemini':
      return [{ functionDeclarations: offered.map(({ name, description, parameters }) => ({ name, description, parameters: geminiSchema(copy(parameters)) })) }];
    case 'generic':
      return offered.map(copy);
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
 * `screenshots` : le modèle lit les images ; sans lui, une capture demandée est refusée.
 * @returns {Promise<{ text: string, sources: object[], images?: object[], found: object }>}
 */
async function runTool(ws, name, args, { signal, defaults, maxChars, screenshots = false } = {}) {
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
  if (name === 'browse_page' || name === 'search_site') {
    if (!ws.hasBrowser) throw new WebSearchError(CODES.BAD_REQUEST, `unknown tool ${name}`);
    if (!args || typeof args.url !== 'string') throw new WebSearchError(CODES.BAD_REQUEST, `${name} needs a url string`);
    if (args.screenshot === true && !screenshots) throw new WebSearchError(CODES.BAD_REQUEST, 'screenshots are not available for this model');
    const page = name === 'browse_page'
      ? await ws.browse(args.url, { screenshot: args.screenshot === true, quotes: strings(args.quotes)?.slice(0, 5), query: typeof args.query === 'string' ? args.query : undefined, signal })
      : await ws.searchSite(args.url, typeof args.query === 'string' ? args.query : '', { signal });
    return {
      text: formatBrowsedForModel(page, { maxChars }),
      sources: [{ kind: 'web', url: page.finalUrl, title: page.title, domain: page.domain, publishedAt: page.publishedAt, excerpt: page.passages[0]?.text || page.text.slice(0, 300) }],
      images: page.screenshot ? [{ mediaType: page.screenshot.mediaType, data: page.screenshot.data }] : [],
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
  const offered = toolOptions(ws, options);
  return toolList(offered).map(({ name, description, parameters }) => ({
    name,
    description,
    parameters: JSON.parse(JSON.stringify(parameters)),
    kind: 'read',
    risk: 'LOW',
    summary: (args = {}) => (name === 'web_search' ? { query: String(args.query ?? '') }
      : name === 'search_site' ? { url: String(args.url ?? ''), query: String(args.query ?? '') } : { url: String(args.url ?? '') }),
    run: async (args, ctx = {}) => {
      const { text, sources, images } = await runTool(ws, name, args, { signal: ctx.signal, defaults: options.defaults, maxChars, screenshots: offered.screenshots });
      return images?.length ? { data: text, sources, images } : { data: text, sources };
    }
  }));
}

/** Pour createToolRegistry / runAgentLoop de @astratra/ai (qui met de côté au-delà de 12 000 caractères). */
function registryTools(ws, { roles, defaults, maxChars = 10_000, browser } = {}) {
  if (!Array.isArray(roles) || !roles.length) throw new Error('registryTools needs the roles allowed to search.');
  /* Le registre rend du texte seulement : pas de capture d'écran. */
  return toolList(toolOptions(ws, { browser })).map(({ name, description, parameters }) => ({
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

module.exports = {
  toolDefinitions,
  nativeTools,
  registryTools,
  runTool,
  searchArgs,
  toolList,
  TOOL_SCHEMAS: { web_search: SEARCH_SCHEMA, read_page: READ_SCHEMA, browse_page: BROWSE_SCHEMA, search_site: SITE_SEARCH_SCHEMA }
};
