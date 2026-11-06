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
  type WebSearch
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

void exercise;
