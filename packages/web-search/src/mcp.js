/**
 * `@astratra/web-search/mcp` : la recherche servie en MCP, avec les deux mêmes
 * outils (`web_search`, `read_page`) et le même texte cadré.
 *
 * Le SDK MCP officiel (@modelcontextprotocol/sdk) est une dépendance
 * facultative : il n'est chargé qu'ici. Le serveur bas niveau prend les
 * schémas JSON tels quels (sans zod).
 *
 *   const { createMcpServer } = require('@astratra/web-search/mcp');
 *   const server = createMcpServer(ws);
 *   await server.connect(transport);   // StdioServerTransport, Streamable HTTP…
 *
 * Une erreur d'outil revient au client en `isError: true` avec son code et son
 * message (jamais une clé), pas en panne du serveur.
 */

const { toolDefinitions, runTool } = require('./tools');

function loadSdk() {
  try {
    const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
    const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
    return { Server, ListToolsRequestSchema, CallToolRequestSchema };
  } catch (_error) {
    throw new Error('createMcpServer needs @modelcontextprotocol/sdk: npm install @modelcontextprotocol/sdk');
  }
}

/**
 * @param {object} ws  createWebSearch(…)
 * @param {{ name?: string, version?: string, defaults?: object, maxChars?: number }} [options]
 */
function createMcpServer(ws, options = {}) {
  if (!ws || typeof ws.search !== 'function' || typeof ws.read !== 'function') throw new Error('createMcpServer needs a web search from createWebSearch().');
  const { Server, ListToolsRequestSchema, CallToolRequestSchema } = loadSdk();
  const server = new Server(
    { name: options.name || 'astratra-web-search', version: options.version || require('../package.json').version },
    {
      capabilities: { tools: {} },
      instructions: 'Web search where every result is one page of one site. Cite sources by their id and url; never merge two sources into one claim.'
    }
  );
  const tools = toolDefinitions('generic').map(({ name, description, parameters }) => ({
    name,
    description,
    inputSchema: parameters,
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false }
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    try {
      const { text } = await runTool(ws, name, args || {}, { signal: extra?.signal, defaults: options.defaults, maxChars: options.maxChars });
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      if (extra?.signal?.aborted) throw error;
      return { isError: true, content: [{ type: 'text', text: `${error.code || 'WEB_SEARCH_ERROR'}: ${error.code ? error.message : 'the tool failed'}` }] };
    }
  });
  return server;
}

module.exports = { createMcpServer };
