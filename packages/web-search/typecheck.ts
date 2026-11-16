import {
  createWebSearch,
  serperProvider,
  braveProvider,
  tavilyProvider,
  exaProvider,
  gatewayProvider,
  toolDefinitions,
  nativeTools,
  registryTools,
  formatForModel,
  canonicalUrl,
  findQuote,
  verifyPassage,
  runEvaluation,
  recordProviders,
  WebSearchError,
  CODES,
  type SearchResponse,
  type SearchResult,
  type ReadPage,
  type WebSearch,
  type BrowsedPage,
  createBrowserClient,
  createLocalBrowser,
  createBrowserEngine,
  createBrowserService,
  createBrowserSystemdUnit,
  createBrowserFirewall,
  createBrowserPm2App,
  createRequestSigner,
  createSigningKey,
  formatBrowsedForModel,
  robotsAllows,
  parseRobots
} from './src';
import { createMcpServer } from './src/mcp';

const ws: WebSearch = createWebSearch({
  providers: [
    gatewayProvider({ search: async (demande) => ({ fournisseur: 'serper', resultats: [{ titre: demande.requete, url: 'https://example.com', extrait: '' }] }) }),
    serperProvider({ key: () => 'k' }),
    braveProvider({ key: 'k', extraSnippets: true }),
    tavilyProvider({ key: 'k', searchDepth: 'basic' }),
    exaProvider({ key: async () => 'k', type: 'auto' })
  ],
  mode: 'fuse',
  quotas: { brave: { perDay: 1000 } },
  ranking: { maxPerDomain: 2, preferDomains: ['example.org'] },
  reading: { maxBytes: 1_000_000 },
  onReport: (report) => report.costUsd.toFixed(4)
});

async function exercise() {
  const found: SearchResponse = await ws.search({ query: 'q', freshness: 'auto', sites: ['example.com'], read: 1 });
  const first: SearchResult | undefined = found.results[0];
  const cited: string = first ? `${first.id} ${first.url} ${first.snippetFrom}` : '';
  const page: ReadPage = await ws.read('https://example.com/', { quotes: ['x'] });
  const ok: boolean = page.quotes[0]?.found ?? false;
  const text: string = formatForModel(found, { maxChars: 4000 });
  const anthropic = toolDefinitions('anthropic');
  const tools = nativeTools(ws);
  const data: string = (await tools[0].run({ query: 'q' })).data;
  const registry = registryTools(ws, { roles: ['member'] });
  const server = createMcpServer(ws);
  const evaluation = await runEvaluation({ cases: [{ id: 'a', input: { query: 'q' } }], search: (input) => ws.search(input), recorder: recordProviders([]) });
  const error = new WebSearchError(CODES.ALL_FAILED, 'x');
  return [cited, ok, text, anthropic, data, registry, server, evaluation.summary.passed, error.code, canonicalUrl('https://example.com'), findQuote('a', 'a').found, verifyPassage('a', { text: 'a', start: 0, end: 1 })];
}

async function browserExercise() {
  const client = createBrowserClient({ baseUrl: 'http://127.0.0.1:5008', tokenFile: '/etc/astratra/browser-token', breaker: { failureThreshold: 3 } });
  const local = createLocalBrowser({ maxContexts: 1, pageTimeoutMs: 10_000 });
  const withBrowser: WebSearch = createWebSearch({ providers: [serperProvider({ key: 'k' })], browser: client, reading: { browser: 'fallback', minWords: 150 }, allowDomains: ['example.com'] });
  const page: BrowsedPage = await withBrowser.browse('https://example.com/', { screenshot: true, query: 'q' });
  const first: string | undefined = page.links[0]?.url;
  const found: BrowsedPage = await withBrowser.searchSite('https://example.com/', 'q');
  const via: 'opensearch' | 'form' | undefined = found.siteSearch?.via;
  const outcome = await client.open({ url: 'https://example.com/', allowDomains: ['example.com'] });
  const status: string = outcome.ok ? outcome.result.status : outcome.code;
  const engine = createBrowserEngine({ infoUrl: 'https://example.com/agent', maxContexts: 2 });
  const service = createBrowserService({ engine, tokenFile: '/etc/astratra/browser-token' });
  const unit: string = createBrowserSystemdUnit({ node: '/usr/bin/node', user: 'navigateur', tokenFile: '/etc/astratra/browser-token' });
  const rules: string = createBrowserFirewall({ user: 'navigateur', dnsServers: ['127.0.0.53'] });
  const app = createBrowserPm2App({ tokenFile: '/etc/astratra/browser-token' });
  const signer = createRequestSigner({ privateKey: createSigningKey().privateKeyPem, signatureAgent: 'https://example.com' });
  const headers = signer.sign('https://example.org/');
  const tools = nativeTools(withBrowser, { screenshots: true });
  const images = (await tools[2].run({ url: 'https://example.com/', screenshot: true })).images;
  const defs = toolDefinitions('anthropic', { browser: true });
  const allowed: boolean = robotsAllows(parseRobots('User-agent: *\nDisallow: /x'), 'https://example.com/');
  const mcp = createMcpServer(withBrowser, { screenshots: true });
  return [local, first, via, status, service, unit, rules, app, headers.signature, images, defs, allowed, formatBrowsedForModel(page), mcp];
}

void exercise;
void browserExercise;
