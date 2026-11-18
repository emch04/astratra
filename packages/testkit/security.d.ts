/// <reference types="node" />
// Types of `@astratra/testkit/security`: security tests with no dependency, for node:test and Jest.

export interface Random {
  uint32(): number;
  float(): number;
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(list: readonly T[]): T;
  bytes(length: number): Buffer;
  shuffle<T>(list: readonly T[]): T[];
  fork(label?: string): Random;
}
export function createRandom(seed?: number | string): Random;
export function hashString(text: string): number;
/** SECURITY_TEST_SEED when set (to replay a failure), otherwise the fallback. */
export function seedFromEnv(fallback?: number | string): number | string;

export const payloads: {
  sqlInjection: string[];
  xss: string[];
  templateInjection: string[];
  pathTraversal: string[];
  commandInjection: string[];
  headerInjection: string[];
  unicode: string[];
  invalidUtf8(): Buffer[];
  numbers: number[];
  numericStrings: string[];
  noSqlOperators(): Record<string, unknown>[];
  prototypePollution(): Record<string, unknown>[];
  prototypeKeys: string[];
  ssrfUrls: string[];
  ipv6SameSubnet: string[];
  ipSpoofHeaders: Record<string, string>[];
  filenames: string[];
  emails: string[];
  contentTypes: string[];
  passwords: string[];
  all(): string[];
};

export function forgeJwt(options: { header?: Record<string, unknown>; payload?: unknown; secret?: string | Buffer; alg?: 'none' | 'HS256' | 'HS384' | 'HS512' | string }): string;
export function jwtAttacks(token: string, options?: { publicKey?: string | import('node:crypto').KeyObject }): { name: string; token: string }[];
export function jwtClaimAttacks(payload?: Record<string, unknown>, options?: { audience?: string; issuer?: string }): { name: string; payload: Record<string, unknown> }[];
export function decodeJwtPart(part: string): unknown;

export interface Generator<T> {
  generate(random: Random): T;
  shrink(value: T): T[];
}
export const gen: {
  constant<T>(value: T): Generator<T>;
  integer(min?: number, max?: number): Generator<number>;
  edgeNumber(): Generator<number>;
  boolean(): Generator<boolean>;
  elements<T>(list: readonly T[]): Generator<T>;
  oneOf<T>(...generators: Generator<T>[]): Generator<T>;
  string(options?: { min?: number; max?: number; alphabet?: 'alnum' | 'ascii' | 'hostile' | string }): Generator<string>;
  hostileString(): Generator<string>;
  bytes(options?: { min?: number; max?: number }): Generator<Buffer>;
  array<T>(item: Generator<T>, options?: { min?: number; max?: number }): Generator<T[]>;
  record<S extends Record<string, Generator<unknown>>>(shape: S): Generator<{ [K in keyof S]: S[K] extends Generator<infer V> ? V : never }>;
  json(options?: { depth?: number }): Generator<unknown>;
  mutated<T extends string | Buffer>(seeds: readonly T[]): Generator<T>;
  map<T, U>(generator: Generator<T>, transform: (value: T) => U): Generator<U>;
};
export const ALPHABETS: Record<'alnum' | 'ascii' | 'hostile', string>;

export interface PropertyReport<T> {
  passed: boolean;
  runs: number;
  seed: number | string;
  run?: number;
  original?: T;
  counterexample?: T;
  shrinks?: number;
  message?: string;
  error?: unknown;
}
export function checkProperty<T>(generator: Generator<T>, property: (value: T) => unknown, options?: { runs?: number; seed?: number | string; maxShrinks?: number }): Promise<PropertyReport<T>>;
export function assertProperty<T>(generator: Generator<T>, property: (value: T) => unknown, options?: { runs?: number; seed?: number | string; maxShrinks?: number; name?: string }): Promise<PropertyReport<T>>;

export interface FuzzFailure<T> { run: number; seed: number | string; input: T; ms: number; kind: 'crash' | 'timeout' | 'slow' | 'check'; message: string; error?: unknown; result?: unknown }
export interface FuzzOptions<T> {
  generator: Generator<T>;
  runs?: number;
  seed?: number | string;
  timeoutMs?: number;
  isExpectedError?: (error: unknown, input: T) => boolean;
  /** Return false or a message to fail the run. */
  check?: (result: unknown, input: T) => unknown;
  stopAfter?: number;
  name?: string;
}
export interface FuzzReport<T> { passed: boolean; runs: number; seed: number | string; slowestMs: number; failures: FuzzFailure<T>[] }
export function fuzz<T>(target: (input: T) => unknown, options: FuzzOptions<T>): Promise<FuzzReport<T>>;
export function assertFuzz<T>(target: (input: T) => unknown, options: FuzzOptions<T>): Promise<FuzzReport<T>>;
export function defaultExpectedError(error: unknown): boolean;

export interface RegexAttack { prefix: string; pump: string; suffix: string }
export interface RegexReport { safe: boolean; regex: string; tried?: number; attack?: RegexAttack; length?: number; ms?: number; input?: string }
export function checkRegex(regex: RegExp, options?: { maxMs?: number; maxLength?: number; attacks?: RegexAttack[] }): Promise<RegexReport>;
export function assertSafeRegex(regex: RegExp, options?: { maxMs?: number; maxLength?: number; attacks?: RegexAttack[] }): Promise<RegexReport>;
export function attackCandidates(regex: RegExp): RegexAttack[];
export function extractRegexLiterals(sourceText: string): RegExp[];
export interface LinearTimeOptions<T> { build: (size: number) => T; sizes?: number[]; repeats?: number; maxExponent?: number; minMs?: number; maxMs?: number; name?: string }
export interface LinearTimeReport { linear: boolean; timings: { size: number; ms: number }[]; exponent: number | null; reason?: string }
export function checkLinearTime<T>(fn: (input: T) => unknown, options: LinearTimeOptions<T>): LinearTimeReport;
export function assertLinearTime<T>(fn: (input: T) => unknown, options: LinearTimeOptions<T>): LinearTimeReport;

export const bombs: {
  deepJsonArray(depth?: number): string;
  deepJsonObject(depth?: number): string;
  wideJsonObject(keys?: number): string;
  wideJsonArray(items?: number): string;
  hugeString(bytes?: number, char?: string): string;
  endlessLine(bytes?: number): string;
  gzip(bytes?: number): Buffer;
  deflateRaw(bytes?: number): Buffer;
  brotli(bytes?: number): Buffer;
  nestedGzip(bytes?: number): Buffer;
  manyHeaders(count?: number): Record<string, string>;
  hugeHeader(bytes?: number): Record<string, string>;
  repeatedQuery(count?: number, key?: string): string;
  deepQuery(depth?: number): string;
};
export interface BoundedReport { bounded: boolean; ms: number; growthMB: number; refused: boolean; error?: unknown; result?: unknown; problems: string[] }
export function checkBounded(run: () => unknown, options?: { maxMs?: number; maxHeapGrowthMB?: number; sampleEveryMs?: number }): Promise<BoundedReport>;
export function assertBounded(run: () => unknown, options?: { maxMs?: number; maxHeapGrowthMB?: number; sampleEveryMs?: number; name?: string }): Promise<BoundedReport>;

export interface CompareOptions<T> {
  reference: (input: T) => unknown;
  candidate: (input: T) => unknown;
  inputs?: T[];
  generator?: Generator<T>;
  runs?: number;
  seed?: number | string;
  normalize?: (value: unknown, input: T) => unknown;
  normalizeError?: (error: unknown, input: T) => unknown;
  equal?: (a: unknown, b: unknown) => boolean;
  stopAfter?: number;
  name?: string;
}
export interface Outcome { ok: boolean; value?: unknown; message?: string }
export interface CompareReport<T> { same: boolean; compared: number; seed: number | string; mismatches: { index: number; input: T; reference: Outcome; candidate: Outcome }[] }
export function compareImplementations<T>(options: CompareOptions<T>): Promise<CompareReport<T>>;
export function assertSameBehavior<T>(options: CompareOptions<T>): Promise<CompareReport<T>>;

export interface Vector<I = unknown> { id: string; input: I; expected: 'valid' | 'invalid' | 'acceptable' | unknown; comment?: string }
export interface VectorReport { passed: boolean; total: number; failures: { vector: Vector; outcome: { ok: boolean; value?: unknown; error?: unknown } }[] }
export function runVectors<I>(vectors: Vector<I>[], run: (input: I, vector: Vector<I>) => unknown, options?: { equal?: (a: unknown, b: unknown) => boolean }): Promise<VectorReport>;
export function assertVectors<I>(vectors: Vector<I>[], run: (input: I, vector: Vector<I>) => unknown, options?: { equal?: (a: unknown, b: unknown) => boolean; name?: string; source?: string }): Promise<VectorReport>;
export function fromWycheproof(file: { testGroups: { tests: { tcId: number; result: string; comment?: string; flags?: string[] }[] }[] }): Vector[];
export const standardVectors: {
  hotpRfc4226: Vector<{ secret: Buffer; counter: number; digits: number; algorithm: string }>[];
  totpRfc6238: Vector<{ secret: Buffer; time: number; step: number; digits: number; algorithm: string }>[];
  jwsHs256Rfc7515: Vector<{ token: string; jwk: { kty: 'oct'; k: string } }>[];
  webPushRfc8291: (Vector<{ plaintext: Buffer; asPublic: string; asPrivate: string; uaPublic: string; uaPrivate: string; salt: string; authSecret: string; recordSize: number }> & { expected: { ecdhSecret: string; ikm: string; cek: string; nonce: string; body: string } })[];
};

export interface RelationOutcome { ok: boolean; value?: unknown; error?: unknown }
export interface RelationOptions<T> {
  inputs?: T[];
  generator?: Generator<T>;
  runs?: number;
  seed?: number | string;
  transform: (input: T, random: Random) => T;
  run: (input: T) => unknown;
  relation?: (a: RelationOutcome, b: RelationOutcome, input: T, changed: T) => unknown;
  stopAfter?: number;
  name?: string;
}
export interface RelationReport<T> { holds: boolean; checked: number; seed: number | string; failures: { input: T; changed: T; a: RelationOutcome; b: RelationOutcome }[] }
export function checkRelation<T>(options: RelationOptions<T>): Promise<RelationReport<T>>;
export function assertRelation<T>(options: RelationOptions<T>): Promise<RelationReport<T>>;
export const relations: {
  same(a: RelationOutcome, b: RelationOutcome): boolean;
  bothRefused(a: RelationOutcome, b: RelationOutcome): boolean;
  neverMorePermissive(a: RelationOutcome, b: RelationOutcome): boolean;
  changedRefused(a: RelationOutcome, b: RelationOutcome): boolean;
};
export const transforms: {
  reorderKeys<T>(value: T, random: Random): T;
  reformatJson(text: string, random: Random): string;
  upperCase(text: string): string;
  lowerCase(text: string): string;
  nfd(text: string): string;
  nfc(text: string): string;
  zeroWidth(text: string, random: Random): string;
  surroundingSpaces(text: string): string;
  percentEncode(text: string): string;
  flipBit<T extends string | Buffer>(value: T, random: Random): T;
};

export interface TimingOptions<T> { classes: [((random: Random) => T) | T, ((random: Random) => T) | T]; samples?: number; batch?: number; warmup?: number; seed?: number | string; copyInputs?: boolean }
export interface TimingMeasure { t: number; absT: number; percentile?: number; meanA?: number; meanB?: number; countA?: number; countB?: number }
export function measureTiming<T>(fn: (input: T) => unknown, options: TimingOptions<T>): TimingMeasure;
export function checkConstantTime<T>(fn: (input: T) => unknown, options: TimingOptions<T> & { threshold?: number; attempts?: number }): { constant: boolean; threshold: number; runs: TimingMeasure[] };
export function assertConstantTime<T>(fn: (input: T) => unknown, options: TimingOptions<T> & { threshold?: number; attempts?: number; name?: string }): { constant: boolean; threshold: number; runs: TimingMeasure[] };
export function welchT(a: number[], b: number[]): number;

export function captureOutput<T>(run: () => T | Promise<T>, options?: { passThrough?: boolean }): Promise<{ output: string; result?: T; error?: unknown }>;
export interface SecretFinding { kind: string; encoding?: string; excerpt: string }
export interface SecretOptions { secrets?: unknown[]; patterns?: { kind: string; pattern: RegExp }[]; allow?: (string | RegExp)[]; name?: string }
export function findSecrets(text: string, options?: SecretOptions): SecretFinding[];
export function assertNoSecrets(text: string, options?: SecretOptions): void;
export const DEFAULT_SECRET_PATTERNS: { kind: string; pattern: RegExp }[];

export type Decision = 'allow' | 'deny';
export interface MatrixCell { actor: string; action: string; resource: string; expected: Decision; actual: Decision; detail?: unknown }
export interface MatrixOptions<C, R> {
  actors: Record<string, C>;
  actions: string[];
  resources: Record<string, R>;
  expected: (cell: { actor: string; action: string; resource: string; context: C; target: R }) => Decision;
  attempt: (cell: { actor: string; context: C; action: string; resource: string; target: R }) => boolean | number | { status?: number; statusCode?: number; allowed?: boolean } | Promise<boolean | number | { status?: number; statusCode?: number; allowed?: boolean }>;
  name?: string;
}
export interface MatrixReport { passed: boolean; cells: MatrixCell[]; wrong: MatrixCell[]; tooOpen: MatrixCell[]; tooClosed: MatrixCell[] }
export function checkAuthorizationMatrix<C, R>(options: MatrixOptions<C, R>): Promise<MatrixReport>;
export function assertAuthorizationMatrix<C, R>(options: MatrixOptions<C, R>): Promise<MatrixReport>;
export function assertNoCrossAccountAccess<C, R>(options: { owner: C; intruder: C; resources: Record<string, R>; actions?: string[]; attempt: MatrixOptions<C, R>['attempt']; name?: string }): Promise<MatrixReport>;

export interface RaceOutcome<T> { index: number; ok: boolean; value?: T; error?: unknown }
export function race<T>(run: (index: number) => T | Promise<T>, options?: { concurrency?: number }): Promise<{ outcomes: RaceOutcome<T>[]; succeeded: RaceOutcome<T>[]; failed: RaceOutcome<T>[] }>;
export function assertAtMost<T>(run: (index: number) => T | Promise<T>, options?: { max?: number; concurrency?: number; isSuccess?: (outcome: RaceOutcome<T>) => boolean; name?: string }): Promise<{ outcomes: RaceOutcome<T>[]; succeeded: RaceOutcome<T>[]; failed: RaceOutcome<T>[]; successes: RaceOutcome<T>[] }>;

type Fault = ((...args: unknown[]) => unknown) | ((original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown);
export const faults: {
  throwing(error?: unknown): Fault;
  rejecting(error?: unknown): Fault;
  hanging(): Fault;
  delayed(ms: number): Fault;
  flaky(every?: number, error?: unknown): Fault;
  returning(value: unknown): Fault;
};
export function withFault<T>(target: object, method: string, fault: Fault, run: () => T | Promise<T>): Promise<T>;
export function assertFailsClosed(target: object, method: string, fault: Fault, run: () => unknown, options?: { isDenied?: (value: unknown) => boolean; name?: string }): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;

export interface MutationCase { name: string; file: string; before: string; after: string }
export interface MutationResult { name: string; file: string; killed: boolean; exitCode: number | null; timedOut: boolean; output: string }
export interface MutationOptions { cwd?: string; cases: MutationCase[]; command?: [string, string[]] | string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv; onResult?: (result: MutationResult) => void; baseline?: boolean }
export function runMutations(options: MutationOptions): { allKilled: boolean; results: MutationResult[]; survivors: MutationResult[] };
export function assertMutationsKilled(options: MutationOptions): { allKilled: boolean; results: MutationResult[]; survivors: MutationResult[] };

export interface LockfileProblem { name: string; key: string; problem: string }
export interface LockfileOptions { allowedRegistries?: string[]; allowInstallScripts?: string[]; allowSha1?: boolean }
export function checkLockfile(lockfile: string | object, options?: LockfileOptions): { passed: boolean; problems: LockfileProblem[]; packages: number };
export function assertLockfile(lockfile: string | object, options?: LockfileOptions): { passed: boolean; problems: LockfileProblem[]; packages: number };
export interface AllowlistOptions { packageJsons: string | string[]; allowed: string[] | Record<string, string>; includeDev?: boolean; ignore?: (string | RegExp)[] }
export function checkDependencyAllowlist(options: AllowlistOptions): { passed: boolean; unexpected: { name: string; file: string; field: string }[]; unused: string[] };
export function assertDependencyAllowlist(options: AllowlistOptions): { passed: boolean; unexpected: { name: string; file: string; field: string }[]; unused: string[] };

export function describeValue(value: unknown, max?: number): string;
