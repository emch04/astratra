/* @astratra/web-search — une recherche web pour les IA où chaque fait reste attaché à sa page. */

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
export type Freshness = 'day' | 'week' | 'month' | 'year';
export type KeySource = string | (() => string | null | undefined | Promise<string | null | undefined>);

/* ─────────────────── Erreurs ─────────────────── */

export const CODES: Readonly<{
  BAD_REQUEST: 'WEB_SEARCH_BAD_REQUEST';
  NO_PROVIDER: 'WEB_SEARCH_NO_PROVIDER';
  ALL_FAILED: 'WEB_SEARCH_ALL_FAILED';
  PROVIDER_FAILED: 'WEB_SEARCH_PROVIDER_FAILED';
  QUOTA: 'WEB_SEARCH_QUOTA';
  BLOCKED_URL: 'WEB_READ_BLOCKED_URL';
  BLOCKED_ADDRESS: 'WEB_READ_BLOCKED_ADDRESS';
  TOO_MANY_REDIRECTS: 'WEB_READ_TOO_MANY_REDIRECTS';
  TOO_LARGE: 'WEB_READ_TOO_LARGE';
  TIMEOUT: 'WEB_READ_TIMEOUT';
  BAD_STATUS: 'WEB_READ_BAD_STATUS';
  UNSUPPORTED_TYPE: 'WEB_READ_UNSUPPORTED_TYPE';
  READ_FAILED: 'WEB_READ_FAILED';
}>;

export class WebSearchError extends Error {
  constructor(code: string, message: string, details?: { provider?: string; status?: number; retryable?: boolean; quota?: boolean });
  readonly code: string;
  readonly provider?: string;
  readonly status?: number;
  retryable: boolean;
  quota: boolean;
  /** Sur WEB_SEARCH_ALL_FAILED : le compte rendu de la recherche (sans clé). */
  report?: SearchReport;
}
export function redact(text: unknown, secrets?: string[]): string;
export function providerFailure(provider: string, details?: { status?: number; cause?: unknown; secrets?: string[] }): WebSearchError;

/* ─────────────────── Demande ─────────────────── */

export interface SearchInput {
  query: string;
  lang?: string;
  country?: string;
  /** Un filtre ('day'…'year'), 'any', ou 'auto' (défaut : le récent passe devant quand la question le demande). */
  freshness?: Freshness | 'auto' | 'any';
  sites?: string[];
  excludeSites?: string[];
  /** 1 à 20, défaut 8. */
  limit?: number;
  /** Lire les N premières pages (0 à 5) et y ajouter des passages mot pour mot. */
  read?: number;
}

export interface Recency { wanted: boolean; window: Freshness | null; reason: string | null }

export interface SearchRequest {
  query: string;
  lang: string | null;
  country: string | null;
  freshness: Freshness | null;
  recency: Recency;
  sites: string[];
  excludeSites: string[];
  limit: number;
}

export const FRESHNESS: readonly Freshness[];
export const FRESHNESS_DAYS: Readonly<Record<Freshness, number>>;
export const MAX_LIMIT: number;
export function normalizeRequest(input: string | SearchInput, defaults?: { now?: number; lang?: string; country?: string; limit?: number }): SearchRequest;
export function detectRecency(query: string, options?: { now?: number }): Recency;
export function withOperators(request: SearchRequest, options?: { includeSites?: boolean }): string;

/* ─────────────────── Fournisseurs ─────────────────── */

export interface ProviderHit {
  title: string;
  url: string;
  snippet: string;
  /** D'autres extraits de LA MÊME page, donnés par le même moteur. */
  extraSnippets?: string[];
  publishedAt: string | null;
}

export interface SearchProvider {
  id: string;
  /** Estimation par appel réussi ; null quand un tiers compte le coût (la passerelle). */
  costPerCallUsd?: number | null;
  cacheTtlMs?: number;
  search(request: SearchRequest, context: { signal?: AbortSignal; now?: number }): Promise<{ hits: ProviderHit[]; costUsd?: number; engine?: string | null }>;
}

interface ProviderOptions { key: KeySource; fetch?: FetchLike; endpoint?: string; timeoutMs?: number; costPerCallUsd?: number; cacheTtlMs?: number; id?: string }

export function serperProvider(options: ProviderOptions): SearchProvider;
export function braveProvider(options: ProviderOptions & { extraSnippets?: boolean; safesearch?: 'off' | 'moderate' | 'strict' }): SearchProvider;
export function tavilyProvider(options: ProviderOptions & { searchDepth?: 'basic' | 'fast' | 'advanced' }): SearchProvider;
export function exaProvider(options: ProviderOptions & { type?: 'auto' | 'fast' | 'deep'; highlightChars?: number }): SearchProvider;
export const TAVILY_COUNTRIES: Readonly<Record<string, string>>;

/** Une passerelle de recherche à vous : `search` reçoit la demande et rend les résultats dans ce format. */
export function gatewayProvider(options: {
  search: (
    demande: { requete: string; nombre: number; langue?: string; pays?: string; periode?: 'jour' | 'semaine' | 'mois' | 'an' },
    options: { signal?: AbortSignal }
  ) => Promise<{ fournisseur?: string; resultats: Array<{ titre: string; url: string; extrait: string; date?: string }> }>;
  id?: string;
  cacheTtlMs?: number;
}): SearchProvider;

/* ─────────────────── Résultats ─────────────────── */

export interface Passage { text: string; start: number; end: number }

export interface ResultPage {
  status: 'read' | 'failed' | 'other_site';
  finalUrl?: string;
  canonicalUrl?: string;
  title?: string;
  lang?: string | null;
  publishedAt?: string | null;
  truncated?: boolean;
  /** Découpés dans le texte de CETTE page : text === texte.slice(start, end). */
  passages?: Passage[];
}

export interface SearchResult {
  /** S1, S2… : l'identifiant à citer. */
  id: string;
  title: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  publishedAt: string | null;
  /** Le moteur qui a donné la date, ou 'page' quand elle vient de la page lue. */
  dateSource: string | null;
  snippet: string;
  extraSnippets?: string[];
  /** Le seul moteur dont viennent le titre et les extraits. */
  snippetFrom: string;
  foundBy: string[];
  ranks: Record<string, number>;
  score: number;
  page?: ResultPage;
}

export interface ProviderTrace {
  provider: string;
  ok: boolean;
  cached: boolean;
  attempts: number;
  ms: number;
  hits: number;
  costUsd: number | null;
  skipped?: 'resting' | 'quota' | 'quota_store_failed';
  engine?: string;
  error?: { code: string; message: string; status?: number };
}

export interface SearchReport {
  query: string;
  rewrittenQuery?: string;
  mode: 'fuse' | 'fallback';
  recency: Recency;
  providers: ProviderTrace[];
  providersUsed: string[];
  costUsd: number;
  /** false quand un moteur utilisé ne donne pas son coût (la passerelle compte de son côté). */
  costComplete: boolean;
  dropped: { domain: number; freshness: number; perDomain: number; duplicate: number; otherSite: number };
  reads: Array<{ url: string; ok: boolean; ms: number; cached?: boolean; error?: { code: string; message: string } }>;
  ms: number;
}

export interface SearchResponse {
  query: string;
  request: SearchRequest;
  results: SearchResult[];
  report: SearchReport;
  searchedAt: string;
}

export interface QuoteCheck { quote: string; found: boolean; exact?: boolean; start?: number; end?: number; text?: string }

export interface ReadPage {
  url: string;
  finalUrl: string;
  redirects: string[];
  canonicalUrl: string;
  domain: string;
  /** false : l'adresse a mené vers un autre site ; ce texte est celui de cet autre site. */
  sameSite: boolean;
  title: string;
  lang: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  text: string;
  truncated: boolean;
  bytes: number;
  quotes: QuoteCheck[];
  passages: Array<Passage & { score: number }>;
  report: { ms: number; cached: boolean };
}

/* ─────────────────── La recherche ─────────────────── */

export interface CacheStore {
  get(key: string): unknown | Promise<unknown>;
  set(key: string, value: unknown, ttlMs: number): unknown | Promise<unknown>;
}
export interface CounterStore {
  get(key: string): number | Promise<number>;
  incr(key: string, ttlMs: number): number | Promise<number>;
}

export interface RankingOptions {
  blockDomains?: string[];
  preferDomains?: string[];
  demoteDomains?: string[];
  domainScore?: (domain: string) => number;
  maxPerDomain?: number;
}

export interface ReadingOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  maxChars?: number;
  passages?: number;
  passageSize?: number;
  ports?: number[];
  userAgent?: string;
}

export interface WebSearchOptions {
  providers: SearchProvider[];
  mode?: 'fuse' | 'fallback';
  fuseCount?: number;
  fallbackOnEmpty?: boolean;
  cache?: CacheStore | false;
  cacheTtlMs?: number;
  readCacheTtlMs?: number;
  quotas?: Record<string, { perMinute?: number; perDay?: number; perMonth?: number }>;
  quotaStore?: CounterStore;
  retry?: { retries?: number; baseDelayMs?: number; maxDelayMs?: number };
  cooldownMs?: number;
  budgetMs?: number;
  ranking?: RankingOptions;
  reading?: ReadingOptions;
  rewrite?: (request: SearchRequest) => string | { query: string } | null | undefined | Promise<string | { query: string } | null | undefined>;
  extract?: (html: string, context: { url: string; now: number }) => Partial<ExtractedPage> & { text: string } | Promise<Partial<ExtractedPage> & { text: string }>;
  onReport?: (report: SearchReport) => void;
  lang?: string;
  country?: string;
  limit?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  request?: (...args: any[]) => any;
  resolve?: (...args: any[]) => any;
}

export interface WebSearch {
  search(input: string | SearchInput, options?: { signal?: AbortSignal }): Promise<SearchResponse>;
  read(url: string, options?: { quotes?: string[]; query?: string; passages?: number; lang?: string; signal?: AbortSignal }): Promise<ReadPage>;
  readonly providerIds: string[];
}

export function createWebSearch(options: WebSearchOptions): WebSearch;

/* ─────────────────── Briques ─────────────────── */

export function parseHttps(value: unknown): URL | null;
export function domainOf(value: string | URL): string | null;
export function canonicalUrl(value: unknown): string | null;
export function normalizeSite(site: unknown): string | null;
export function inSite(domain: string | null, site: string | null): boolean;
export function sameSite(a: string, b: string): boolean;
export const TRACKING_PARAMS: ReadonlySet<string>;

export function parseDate(value: unknown, options?: { now?: number }): string | null;
export function ageInDays(iso: string | null, now?: number): number | null;

export interface FusedEntry {
  canonicalUrl: string; url: string; domain: string; title: string; snippet: string; extraSnippets: string[];
  snippetFrom: string; publishedAt: string | null; dateSource: string | null; foundBy: string[]; ranks: Record<string, number>; score: number;
}
export const RRF_K: number;
export function fuseRankings(lists: Array<{ provider: string; hits: ProviderHit[]; weight?: number }>, options?: { k?: number }): FusedEntry[];
export function rankEntries(entries: FusedEntry[], request: SearchRequest, options?: RankingOptions & { now?: number }): { entries: FusedEntry[]; dropped: { domain: number; freshness: number; perDomain: number } };

export function isPublicAddress(address: string): boolean;
export function isBlockedHostname(hostname: string): boolean;

export const SAFE_FETCH_DEFAULTS: Readonly<{ timeoutMs: number; maxBytes: number; maxRedirects: number; ports: number[]; userAgent: string }>;
export function safeFetch(url: string, options?: ReadingOptions & { lang?: string; signal?: AbortSignal; request?: (...args: any[]) => any; resolve?: (...args: any[]) => any }): Promise<{
  url: string; finalUrl: string; redirects: string[]; status: number; contentType: string; body: string; bytes: number; truncated: boolean;
}>;
export function safeLookup(resolve?: (...args: any[]) => any): (hostname: string, options: any, callback: (...args: any[]) => void) => void;
export function checkUrl(url: string, ports: number[]): URL;

export interface ExtractedPage {
  title: string; text: string; lang: string | null; canonical: string | null; publishedAt: string | null;
  modifiedAt: string | null; description: string | null; siteName: string | null;
}
export function extractPage(html: string, options?: { url?: string; now?: number }): ExtractedPage;
export function removeElements(html: string, drop: (tagName: string, openingTag: string) => boolean): string;
export function toText(html: string): string;

export function findQuote(text: string, quote: string): QuoteCheck;
export function verifyPassage(text: string, passage: Passage | null | undefined): boolean;
export function bestPassages(text: string, query: string, options?: { count?: number; size?: number }): Array<Passage & { score: number }>;
export function termsOf(query: string): string[];

export function createMemoryCache(options?: { maxEntries?: number; now?: () => number }): CacheStore & { clear(): void; size(): number };
export function createMemoryCounters(options?: { now?: () => number }): CounterStore;

/* ─────────────────── Pour les modèles ─────────────────── */

export const CITATION_RULES: string;
export function formatForModel(found: SearchResponse, options?: { maxChars?: number; snippetChars?: number; passageChars?: number }): string;
export function formatPageForModel(page: ReadPage, options?: { maxChars?: number }): string;

export type ToolFormat = 'anthropic' | 'openai' | 'mistral' | 'gemini' | 'generic';
export const TOOL_SCHEMAS: Readonly<{ web_search: Record<string, unknown>; read_page: Record<string, unknown> }>;
export function toolDefinitions(format?: ToolFormat): any[];
export function searchArgs(args: Record<string, unknown>, defaults?: { limit?: number; read?: number }): SearchInput;

export interface WebSource { kind: 'web'; id?: string; url: string; title: string; domain: string; publishedAt: string | null; excerpt: string }
export function runTool(ws: WebSearch, name: 'web_search' | 'read_page' | string, args: Record<string, unknown>, options?: {
  signal?: AbortSignal; defaults?: { limit?: number; read?: number }; maxChars?: number;
}): Promise<{ text: string; sources: WebSource[]; found: SearchResponse | ReadPage }>;

export interface WebNativeTool {
  name: 'web_search' | 'read_page';
  description: string;
  parameters: Record<string, unknown>;
  kind: 'read';
  risk: 'LOW';
  summary(args?: Record<string, unknown>): Record<string, string>;
  run(args: Record<string, unknown>, ctx?: { signal?: AbortSignal }): Promise<{ data: string; sources: WebSource[] }>;
}
export function nativeTools(ws: WebSearch, options?: { defaults?: { limit?: number; read?: number }; maxChars?: number }): WebNativeTool[];

export interface WebRegistryTool {
  name: 'web_search' | 'read_page';
  description: string;
  type: 'read';
  risk: 'LOW';
  external: true;
  roles: string[];
  params: Record<string, string>;
  handler(params: Record<string, unknown>, ctx?: { signal?: AbortSignal }): Promise<string>;
}
export function registryTools(ws: WebSearch, options: { roles: string[]; defaults?: { limit?: number; read?: number }; maxChars?: number }): WebRegistryTool[];

/* ─────────────────── Évaluation ─────────────────── */

export interface EvaluationCase {
  id: string;
  input: SearchInput;
  expect?: { expectedDomain?: string; within?: number; recentFirst?: boolean; forbiddenDomains?: string[] };
}
export interface EvaluationRecorder {
  providers: SearchProvider[];
  hitsFor(providerId: string, url: string): ProviderHit[];
}
export function recordProviders(providers: SearchProvider[]): EvaluationRecorder;
export function rawSearch(provider: SearchProvider, request: Partial<SearchRequest> & { query: string }): Promise<{ query: string; results: Array<Partial<SearchResult>> }>;
export function checkCase(found: { results: Array<Partial<SearchResult>> }, expect: EvaluationCase['expect'], context: { recorder?: EvaluationRecorder; pageTexts: Map<string, string> }): Record<string, boolean>;
export function runEvaluation(options: {
  cases: EvaluationCase[];
  search: (input: SearchInput) => Promise<{ results: Array<Partial<SearchResult>> }>;
  recorder?: EvaluationRecorder;
  readText?: (url: string) => Promise<string>;
}): Promise<{
  cases: Array<{ id: string; passed: boolean; error?: string; checks: Record<string, boolean>; results?: Array<{ id: string; domain: string; url: string; publishedAt: string | null }> }>;
  summary: { cases: number; passed: number; checks: Record<string, { passed: number; total: number }> };
}>;
