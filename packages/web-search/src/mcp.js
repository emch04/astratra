/**
 * `@astratra/web-search/mcp` : la recherche servie en MCP, avec les mêmes
 * outils (`web_search`, `read_page`, et `browse_page`, `search_site` quand le
 * navigateur est branché) et le même texte cadré. Une capture d'écran revient
 * en contenu image, seulement avec `screenshots: true`.
 *
 * Le protocole vient de @astratra/mcp (sans dépendance) ; un transport du
 * SDK officiel se branche aussi tel quel.
 *
 *   const { createMcpServer } = require('@astratra/web-search/mcp');
 *   const server = createMcpServer(ws);
 *   await server.connect(transport);   // createStdioServerTransport(), createStreamableHttpHandler…
 *
 * Une erreur d'outil revient au client en `isError: true` avec son code et son
 * message (jamais une clé), pas en panne du serveur.
 */

const { createMcpServer: createProtocolServer } = require('@astratra/mcp');
const { toolDefinitions, runTool } = require('./tools');

/**
 * @param {object} ws  createWebSearch(…)
 * @param {{ name?: string, version?: string, defaults?: object, maxChars?: number, browser?: boolean, screenshots?: boolean }} [options]
 */
function createMcpServer(ws, options = {}) {
  if (!ws || typeof ws.search !== 'function' || typeof ws.read !== 'function') throw new Error('createMcpServer needs a web search from createWebSearch().');
  const server = createProtocolServer(
    { name: options.name || 'astratra-web-search', version: options.version || require('../package.json').version },
    {
      capabilities: { tools: {} },
      instructions: 'Web search where every result is one page of one site. Cite sources by their id and url; never merge two sources into one claim.'
    }
  );
  const offered = { browser: Boolean(ws.hasBrowser) && options.browser !== false, screenshots: options.screenshots === true };
  const tools = toolDefinitions('generic', offered).map(({ name, description, parameters }) => ({
    name,
    description,
    inputSchema: parameters,
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false }
  }));
  server.setRequestHandler('tools/list', async () => ({ tools }));
  server.setRequestHandler('tools/call', async (request, extra) => {
    const { name, arguments: args } = request.params || {};
    try {
      if ((name === 'browse_page' || name === 'search_site') && !offered.browser) throw Object.assign(new Error(`unknown tool ${name}`), { code: 'WEB_SEARCH_BAD_REQUEST' });
      const { text, images } = await runTool(ws, name, args || {}, { signal: extra?.signal, defaults: options.defaults, maxChars: options.maxChars, screenshots: offered.screenshots });
      return { content: [{ type: 'text', text }, ...(images || []).map((image) => ({ type: 'image', data: image.data, mimeType: image.mediaType }))] };
    } catch (error) {
      if (extra?.signal?.aborted) throw error;
      return { isError: true, content: [{ type: 'text', text: `${error.code || 'WEB_SEARCH_ERROR'}: ${error.code ? error.message : 'the tool failed'}` }] };
    }
  });
  return server;
}

module.exports = { createMcpServer };
