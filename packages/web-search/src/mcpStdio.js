#!/usr/bin/env node
/**
 * Le serveur MCP en stdio, prêt pour un client (éditeur, assistant de bureau).
 *
 * Les moteurs viennent de l'environnement, dans cet ordre :
 *   SERPER_API_KEY, BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, EXA_API_KEY  des clés directes.
 * WEB_SEARCH_MODE=fallback pour un moteur à la fois (défaut : fuse).
 * Navigateur intégré (facultatif) : WEB_BROWSER_URL (ex. http://127.0.0.1:5008) +
 * WEB_BROWSER_TOKEN_FILE ajoutent browse_page et search_site ;
 * WEB_BROWSER_SCREENSHOTS=1 si le client lit les images.
 *
 * Rien n'est écrit sur stdout hors du protocole ; les clés ne sont jamais écrites.
 */

const { createWebSearch, serperProvider, braveProvider, tavilyProvider, exaProvider } = require('./index');
const { createBrowserClient } = require('./browser/client');
const { createMcpServer } = require('./mcp');

async function providersFromEnv(env) {
  const providers = [];
  if (env.SERPER_API_KEY) providers.push(serperProvider({ key: () => env.SERPER_API_KEY }));
  if (env.BRAVE_SEARCH_API_KEY) providers.push(braveProvider({ key: () => env.BRAVE_SEARCH_API_KEY }));
  if (env.TAVILY_API_KEY) providers.push(tavilyProvider({ key: () => env.TAVILY_API_KEY }));
  if (env.EXA_API_KEY) providers.push(exaProvider({ key: () => env.EXA_API_KEY }));
  return providers;
}

/** Le client du navigateur intégré, si WEB_BROWSER_URL et WEB_BROWSER_TOKEN_FILE sont donnés. */
function browserFromEnv(env) {
  if (!env.WEB_BROWSER_URL) return null;
  if (!env.WEB_BROWSER_TOKEN_FILE) {
    process.stderr.write('web-search: WEB_BROWSER_URL needs WEB_BROWSER_TOKEN_FILE; the browser is skipped.\n');
    return null;
  }
  return createBrowserClient({ baseUrl: env.WEB_BROWSER_URL, tokenFile: env.WEB_BROWSER_TOKEN_FILE });
}

async function main() {
  const providers = await providersFromEnv(process.env);
  if (!providers.length) {
    process.stderr.write('web-search: no search provider configured (SERPER_API_KEY, BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, EXA_API_KEY).\n');
    process.exit(1);
  }
  const browser = browserFromEnv(process.env);
  const ws = createWebSearch({ providers, mode: process.env.WEB_SEARCH_MODE === 'fallback' ? 'fallback' : 'fuse', ...(browser ? { browser } : {}) });
  const { createStdioServerTransport } = require('@astratra/mcp');
  await createMcpServer(ws, { screenshots: process.env.WEB_BROWSER_SCREENSHOTS === '1' }).connect(createStdioServerTransport());
  process.stderr.write(`web-search: MCP server ready (${ws.providerIds.join(', ')}${browser ? ', browser' : ''}).\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`web-search: ${error.code || 'error'}: ${error.code ? error.message : 'could not start'}\n`);
    process.exit(1);
  });
}

module.exports = { providersFromEnv, browserFromEnv };
