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
  BROWSER_UNAVAILABLE: 'WEB_BROWSER_UNAVAILABLE';
  BROWSE_REFUSED: 'WEB_BROWSE_REFUSED';
  BROWSE_FAILED: 'WEB_BROWSE_FAILED';
  BROWSE_ROBOTS: 'WEB_BROWSE_ROBOTS_DISALLOWED';
  BROWSE_BUSY: 'WEB_BROWSE_BUSY';
  BROWSE_TIMEOUT: 'WEB_BROWSE_TIMEOUT';
  NO_SITE_SEARCH: 'WEB_BROWSE_NO_SITE_SEARCH';
  BLOCKED_DOMAIN: 'WEB_READ_BLOCKED_DOMAIN';
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
  /** null quand la page a été lue par le navigateur. */
  bytes: number | null;
  /** fetch : lecture simple ; browser : page rendue par le navigateur intégré. */
  via: 'fetch' | 'browser';
  quotes: QuoteCheck[];
  passages: Array<Passage & { score: number }>;
  report: { ms: number; cached: boolean };
}

/** Un lien d'une page rendue : numéroté, ceux du même site d'abord. */
export interface BrowsedLink { n: number; url: string; text: string; sameSite: boolean }
export interface Screenshot { mediaType: 'image/png'; data: string; width?: number; height?: number }

/** Une page ouverte par le navigateur (ws.browse), ou la page de résultats de la recherche interne d'un site (ws.searchSite). */
export interface BrowsedPage extends ReadPage {
  via: 'browser';
  links: BrowsedLink[];
  screenshot?: Screenshot;
  siteSearch?: { query: string; via: 'opensearch' | 'form'; searchUrl: string };
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
  /** Avec un navigateur : 'fallback' (défaut, sous minWords mots), 'always' ou 'never'. */
  browser?: 'fallback' | 'always' | 'never';
  /** En dessous, la lecture simple passe la main au navigateur. Défaut 200. */
  minWords?: number;
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
  /** Le navigateur intégré : createBrowserClient(…) ou createLocalBrowser(…). */
  browser?: BrowserBackend;
  /** Si donné, seules ces pages (et leurs sous-domaines) sont lues ou ouvertes. */
  allowDomains?: string[];
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
  /** La page rendue par le navigateur, ses liens numérotés, sa capture sur demande. */
  browse(url: string, options?: { screenshot?: boolean; quotes?: string[]; query?: string; passages?: number; lang?: string; signal?: AbortSignal }): Promise<BrowsedPage>;
  /** La recherche interne d'un site (OpenSearch ou formulaire GET), sans clic. */
  searchSite(url: string, query: string, options?: { screenshot?: boolean; passages?: number; lang?: string; signal?: AbortSignal }): Promise<BrowsedPage>;
  readonly hasBrowser: boolean;
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
export function formatBrowsedForModel(page: BrowsedPage, options?: { maxChars?: number; maxLinks?: number }): string;

export type ToolFormat = 'anthropic' | 'openai' | 'mistral' | 'gemini' | 'generic';
export type WebToolName = 'web_search' | 'read_page' | 'browse_page' | 'search_site';
export const TOOL_SCHEMAS: Readonly<{ web_search: Record<string, unknown>; read_page: Record<string, unknown>; browse_page: Record<string, unknown>; search_site: Record<string, unknown> }>;
/** browser : ajouter browse_page et search_site ; screenshots : le modèle lit les images. */
export function toolDefinitions(format?: ToolFormat, options?: { browser?: boolean; screenshots?: boolean }): any[];
export function toolList(options?: { browser?: boolean; screenshots?: boolean }): Array<{ name: WebToolName; description: string; parameters: Record<string, unknown> }>;
export function searchArgs(args: Record<string, unknown>, defaults?: { limit?: number; read?: number }): SearchInput;

export interface WebSource { kind: 'web'; id?: string; url: string; title: string; domain: string; publishedAt: string | null; excerpt: string }
export interface ToolImage { mediaType: 'image/png'; data: string }
export function runTool(ws: WebSearch, name: WebToolName | string, args: Record<string, unknown>, options?: {
  signal?: AbortSignal; defaults?: { limit?: number; read?: number }; maxChars?: number; screenshots?: boolean;
}): Promise<{ text: string; sources: WebSource[]; images?: ToolImage[]; found: SearchResponse | ReadPage | BrowsedPage }>;

export interface WebNativeTool {
  name: WebToolName;
  description: string;
  parameters: Record<string, unknown>;
  kind: 'read';
  risk: 'LOW';
  summary(args?: Record<string, unknown>): Record<string, string>;
  /** images : la capture d'écran, seulement avec { screenshots: true }. */
  run(args: Record<string, unknown>, ctx?: { signal?: AbortSignal }): Promise<{ data: string; sources: WebSource[]; images?: ToolImage[] }>;
}
/** Avec un navigateur branché, browse_page et search_site s'ajoutent (browser: false pour les retirer). */
export function nativeTools(ws: WebSearch, options?: { defaults?: { limit?: number; read?: number }; maxChars?: number; browser?: boolean; screenshots?: boolean }): WebNativeTool[];

export interface WebRegistryTool {
  name: WebToolName;
  description: string;
  type: 'read';
  risk: 'LOW';
  external: true;
  roles: string[];
  params: Record<string, string>;
  handler(params: Record<string, unknown>, ctx?: { signal?: AbortSignal }): Promise<string>;
}
export function registryTools(ws: WebSearch, options: { roles: string[]; defaults?: { limit?: number; read?: number }; maxChars?: number; browser?: boolean }): WebRegistryTool[];

/* ─────────────────── Navigateur intégré ─────────────────── */

export type BrowserStatus =
  | 'ok' | 'blocked' | 'robots_disallowed' | 'domain_refused' | 'bad_status' | 'timeout' | 'too_many_redirects'
  | 'unsupported_type' | 'no_site_search' | 'search_engine_refused' | 'failed' | 'busy' | 'invalid_input' | 'browser_unavailable';

/** Ce que rend le service (ou le moteur) pour une page. */
export interface BrowserResult {
  status: BrowserStatus;
  url?: string;
  finalUrl?: string;
  httpStatus?: number;
  title?: string;
  lang?: string | null;
  text?: string;
  links?: BrowsedLink[];
  canonical?: string | null;
  publishedAt?: string | null;
  modifiedAt?: string | null;
  truncated?: boolean;
  resourceLimitReached?: boolean;
  blockedRequests?: number;
  removed?: { overlays: number; hidden: number };
  screenshot?: Screenshot;
  searchUrl?: string;
  via?: 'opensearch' | 'form';
  query?: string;
  reason?: string;
  blockedUrl?: string;
  robotsUnavailable?: boolean;
  ms?: number;
}

export interface BrowserOpenRequest { url: string; screenshot?: boolean; waitFor?: string; allowDomains?: string[]; blockDomains?: string[]; lang?: string }
export interface BrowserSiteSearchRequest { url: string; query: string; screenshot?: boolean; allowDomains?: string[]; blockDomains?: string[]; lang?: string }

export type BrowserCallResult =
  | { ok: true; result: BrowserResult }
  | { ok: false; code: string; retryable: boolean; status?: number; message?: string };

/** Ce que createWebSearch attend dans `browser`. */
export interface BrowserBackend {
  open(request: BrowserOpenRequest, options?: { signal?: AbortSignal }): Promise<BrowserCallResult>;
  siteSearch(request: BrowserSiteSearchRequest, options?: { signal?: AbortSignal }): Promise<BrowserCallResult>;
  health?(options?: { signal?: AbortSignal }): Promise<{ ok: true; result: any } | { ok: false; code: string; retryable: boolean }>;
}

export interface BrowserClient extends BrowserBackend {
  health(options?: { signal?: AbortSignal }): Promise<{ ok: true; result: any } | { ok: false; code: string; retryable: boolean }>;
  breakerStatus(): { state: 'closed' | 'open' | 'half-open'; failures: number } | null;
  readonly kind: 'service';
}
export function createBrowserClient(options?: {
  baseUrl?: string;
  token?: string | (() => string | Promise<string>);
  tokenFile?: string;
  fetch?: (url: string, init?: any) => Promise<any>;
  timeoutMs?: number;
  retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  breaker?: { failureThreshold?: number; recoveryMs?: number } | false;
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): BrowserClient;

export interface BrowserEngineOptions {
  playwright?: unknown;
  executablePath?: string;
  infoUrl?: string;
  userAgent?: string;
  signer?: RequestSigner | null;
  robots?: boolean;
  fetchRobots?: (url: string, ctx: { signal?: AbortSignal }) => Promise<{ status: number; body: string }>;
  ports?: number[];
  allowHttp?: boolean;
  resolve?: (...args: any[]) => any;
  proxyPort?: number;
  maxContexts?: number;
  queueMs?: number;
  maxQueue?: number;
  pageTimeoutMs?: number;
  requestTimeoutMs?: number;
  settleMs?: number;
  maxRedirects?: number;
  maxResourceBytes?: number;
  maxTextChars?: number;
  maxLinks?: number;
  /** Tests seulement. */
  connect?: (target: { hostname: string; address: string; port: number }) => unknown;
  /** Tests seulement : certificats non vérifiés. */
  insecureTls?: boolean;
}
export interface BrowserEngine {
  open(request: BrowserOpenRequest, options?: { signal?: AbortSignal }): Promise<BrowserResult>;
  siteSearch(request: BrowserSiteSearchRequest, options?: { signal?: AbortSignal }): Promise<BrowserResult>;
  health(): Promise<{ ok: boolean; version: string; chromium: string | null; sandbox: boolean; userAgent: string; robots: boolean; signing: { keyid: string } | null; active: number; queued: number; max: number; error?: string }>;
  start(): Promise<unknown>;
  close(): Promise<void>;
  readonly userAgent: string;
}
export function createBrowserEngine(options?: BrowserEngineOptions): BrowserEngine;
/** Pour le développement : refuse NODE_ENV=production sans allowInProduction: true. */
export function createLocalBrowser(options?: BrowserEngineOptions & { engine?: BrowserEngine; allowInProduction?: boolean }): BrowserBackend & { start(): Promise<unknown>; close(): Promise<void>; readonly kind: 'local' };
export function browserUserAgent(options?: { version?: string; infoUrl?: string }): string;
export const BROWSER_DEFAULTS: Readonly<{ maxContexts: number; queueMs: number; maxQueue: number; pageTimeoutMs: number; requestTimeoutMs: number; settleMs: number; maxRedirects: number; maxResourceBytes: number; maxTextChars: number; maxLinks: number; viewport: { width: number; height: number } }>;
export const DEFAULT_INFO_URL: string;

export interface IsolationReport { ok: boolean; checkedAt: string; probes: Array<{ name: string; host: string; port: number; outcome: 'reached' | 'blocked' | 'timeout' | 'unreachable' }> }
export function checkIsolation(options: { servicePort?: number; timeoutMs?: number; targets?: Array<{ name: string; host: string; port: number }>; connect?: (...args: any[]) => any }): Promise<IsolationReport>;

export function createBrowserService(options: {
  engine: BrowserEngine;
  tokenFile: string;
  host?: '127.0.0.1' | '::1';
  port?: number;
  unsafeNoFirewall?: boolean;
  checkIsolation?: (options: { servicePort: number }) => Promise<IsolationReport>;
  log?: (event: { route: string; outcome: string; ms: number }) => void;
}): {
  start(): Promise<{ host: string; port: number; isolation: IsolationReport }>;
  close(): Promise<void>;
  address(): unknown;
  isolation(): IsolationReport | null;
};

export function startEgressProxy(options?: { resolve?: (...args: any[]) => any; connect?: (...args: any[]) => any; ports?: number[]; allowHttp?: boolean; port?: number; host?: string; idleMs?: number; onRefused?: (event: { hostname: string; port: number; reason: string }) => void }): Promise<{
  port: number; server: string; username: string; password: string; stats(): { tunnels: number; refused: number; open: number }; close(): Promise<void>;
}>;

export interface ParsedRobots { groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> }
export function parseRobots(text: string): ParsedRobots;
export function robotsAllows(parsed: ParsedRobots | { allowAll: true } | { disallowAll: true }, target: string | URL, token?: string): boolean;
export function createRobotsCache(options: { fetchRobots: (url: string, ctx: { signal?: AbortSignal }) => Promise<{ status: number; body: string }>; ttlMs?: number; errorTtlMs?: number; maxEntries?: number; token?: string; now?: () => number }): {
  check(target: string | URL, options?: { signal?: AbortSignal }): Promise<{ allowed: boolean; unavailable?: boolean }>;
  clear(): void;
  size(): number;
};
export const ROBOTS_AGENT_TOKEN: 'AstratraWebBrowser';

export function openSearchUrl(xml: string, context: { query: string; pageUrl: string }): string | null;
export function formSearchUrl(form: { action?: string; method?: string; searchRole?: boolean; fields: Array<{ name: string; type: string; value?: string; checked?: boolean }> }, context: { query: string; pageUrl: string }): string | null;
export function isSearchEngine(value: string): boolean;
export const SEARCH_ENGINES: readonly string[];

export interface RequestSigner {
  sign(url: string | URL): { 'signature-agent': string; 'signature-input': string; signature: string };
  readonly keyid: string;
  readonly publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string };
}
export function createSigningKey(): { privateKeyPem: string; publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string } };
export function createRequestSigner(options: { privateKey: string | unknown; signatureAgent: string; validitySeconds?: number; now?: () => number }): RequestSigner;
export function signerFromFile(options?: { signingKeyFile?: string; signatureAgent?: string }): RequestSigner | null;
export function jwkThumbprint(jwk: { kty: string; crv: string; x: string }): string;
export function signatureDirectory(publicJwks: { kty: string; crv: string; x: string } | Array<{ kty: string; crv: string; x: string }>): { keys: Array<{ kty: 'OKP'; crv: 'Ed25519'; x: string }> };
export const SIGNATURE_DIRECTORY_PATH: string;
export const SIGNATURE_DIRECTORY_TYPE: string;

export interface BrowserDeployOptions {
  port?: number;
  proxyPort?: number;
  maxContexts?: number;
  queueMs?: number;
  infoUrl?: string;
  signatureAgent?: string;
  browsersPath?: string;
  tokenFile?: string;
  signingKeyFile?: string;
  env?: Record<string, string>;
}
export function browserServiceEnv(options?: BrowserDeployOptions): Record<string, string>;
export function createBrowserSystemdUnit(options: BrowserDeployOptions & {
  node: string; user: string; tokenFile: string; script?: string; group?: string; description?: string; workingDirectory?: string;
  environmentFile?: string; memoryMax?: string; memoryHigh?: string; cpuQuota?: string; tasksMax?: number; restartSec?: number; readWritePaths?: string[];
}): string;
export function createBrowserPm2App(options: BrowserDeployOptions & { tokenFile: string; node?: string; script?: string; name?: string; cwd?: string; maxRestarts?: number; restartDelay?: number; killTimeout?: number; maxMemoryRestart?: string }): Record<string, unknown>;
export function createBrowserFirewall(options?: { user?: string; proxyPort?: number; dnsServers?: string[]; table?: string }): string;
/** L'unité systemd qui charge la seule table du navigateur au démarrage, avant le service. */
export function createBrowserFirewallUnit(options?: { nftFile?: string; nft?: string }): string;
export function createBrowserAppArmorProfile(options: { chromiumPath: string; name?: string }): string;
/** clientsGroup : le groupe des applications qui lisent le jeton (défaut astratra-browser). */
export function browserSetupFiles(options: Parameters<typeof createBrowserSystemdUnit>[0] & { chromiumPath?: string; dnsServers?: string[]; table?: string; clientsGroup?: string; nftFile?: string }): Record<string, string>;
export const BROWSER_CLI: string;

export const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]>;
export const BLOCKED_IPV6: ReadonlyArray<readonly [string, number]>;

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
