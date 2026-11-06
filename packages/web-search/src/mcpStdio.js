#!/usr/bin/env node
/**
 * Le serveur MCP en stdio, prêt pour un client (éditeur, assistant de bureau).
 *
 * Les moteurs viennent de l'environnement, dans cet ordre :
 *   SERPER_API_KEY, BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, EXA_API_KEY  des clés directes.
 * WEB_SEARCH_MODE=fallback pour un moteur à la fois (défaut : fuse).
 *
 * Rien n'est écrit sur stdout hors du protocole ; les clés ne sont jamais écrites.
 */

const { createWebSearch, serperProvider, braveProvider, tavilyProvider, exaProvider, gatewayProvider } = require('./index');
const { createMcpServer } = require('./mcp');

async function providersFromEnv(env) {
  const providers = [];
  if (env.SERPER_API_KEY) providers.push(serperProvider({ key: () => env.SERPER_API_KEY }));
  if (env.BRAVE_SEARCH_API_KEY) providers.push(braveProvider({ key: () => env.BRAVE_SEARCH_API_KEY }));
  if (env.TAVILY_API_KEY) providers.push(tavilyProvider({ key: () => env.TAVILY_API_KEY }));
  if (env.EXA_API_KEY) providers.push(exaProvider({ key: () => env.EXA_API_KEY }));
  return providers;
}

async function main() {
  const providers = await providersFromEnv(process.env);
  if (!providers.length) {
    process.stderr.write('web-search: no search provider configured (SERPER_API_KEY, BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, EXA_API_KEY).\n');
    process.exit(1);
  }
  const ws = createWebSearch({ providers, mode: process.env.WEB_SEARCH_MODE === 'fallback' ? 'fallback' : 'fuse' });
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  await createMcpServer(ws).connect(new StdioServerTransport());
  process.stderr.write(`web-search: MCP server ready (${ws.providerIds.join(', ')}).\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`web-search: ${error.code || 'error'}: ${error.code ? error.message : 'could not start'}\n`);
    process.exit(1);
  });
}

module.exports = { providersFromEnv };
