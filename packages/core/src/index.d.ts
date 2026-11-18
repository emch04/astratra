export interface JsonResponder {
  json(payload: unknown): unknown;
}

export interface ResponseLike {
  status(statusCode: number): JsonResponder;
  setHeader?(name: string, value: string): unknown;
  set?(name: string, value: string): unknown;
}

export interface RequestLike {
  headers?: Record<string, string | undefined>;
  log?: {
    error?: (...args: unknown[]) => unknown;
  };
  originalUrl?: string;
  requestId?: string;
  url?: string;
  [key: string]: unknown;
}

export type NextFunction = (error?: unknown) => unknown;
export type RequestHandler = (req: RequestLike, res: ResponseLike, next: NextFunction) => unknown;
export type ErrorRequestHandler = (err: Error & { status?: number; statusCode?: number }, req: RequestLike, res: ResponseLike, next: NextFunction) => unknown;

export interface ApiResponsePayload<T = unknown> {
  success: boolean;
  message: string;
  data: T | null;
  timestamp: string;
  error?: string;
}

export function apiResponse<T = unknown>(
  res: ResponseLike,
  statusCode: number,
  message: string,
  data?: T | null,
  success?: boolean
): unknown;

export function asyncHandler(fn: RequestHandler): RequestHandler;

export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
}

export function createLogger(serviceName?: string): Logger;

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;
  constructor(message: string, statusCode?: number);
}

export const errorMiddleware: ErrorRequestHandler;
export function notFoundMiddleware(req: RequestLike, res: ResponseLike): unknown;
export const requestIdMiddleware: RequestHandler;

export interface ValidationLike {
  run(req: RequestLike): unknown | Promise<unknown>;
}

export function validateMiddleware(validations?: ValidationLike[]): RequestHandler;

export type EnvDefault = string | number | boolean | null | undefined;

export interface EnvDefinition<TInput = string | EnvDefault, TOutput = TInput> {
  default?: EnvDefault;
  required?: boolean;
  transform?: (value: TInput) => TOutput;
  validate?: (value: TOutput) => boolean;
}

export type EnvSchema = Record<string, EnvDefault | EnvDefinition<any, any>>;

export type LoadEnvValue<T> =
  T extends { transform: (...args: any[]) => infer R }
    ? R
    : T extends { default: infer D }
      ? D | string | undefined
      : T extends EnvDefault
        ? T | string | undefined
        : string | undefined;

export type LoadedEnv<TSchema extends EnvSchema> = {
  [K in keyof TSchema]: LoadEnvValue<TSchema[K]>;
};

export function loadEnv<TSchema extends EnvSchema = EnvSchema>(schema?: TSchema): LoadedEnv<TSchema>;

/* ────────────────────────── Idempotency ────────────────────────── */

export type IdempotencyStatus = 'in_flight' | 'done';

export interface StoredIdempotentResponse {
  statusCode: number;
  body: unknown;
}

export interface IdempotencyRecord<R = unknown> {
  id: string;
  /** Unique per claim: completes and releases only apply to the claim that holds it. */
  token: string;
  status: IdempotencyStatus;
  payloadHash: string;
  response: R | null;
  createdAt: Date | string;
  /** Stores with a TTL index can expire on this field. */
  expiresAt: Date | string;
}

export interface IdempotencyStore<R = unknown> {
  /** ATOMIC insert-if-absent. `record` is the existing one when not acquired. */
  acquire(id: string, entry: IdempotencyRecord<R>): Promise<{ acquired: boolean; record: IdempotencyRecord<R> }>;
  /** Marks done, only if the record still carries `token`. */
  complete(id: string, token: string, response: R | null): Promise<unknown>;
  /** Deletes, only if the record still carries `token`. */
  release(id: string, token: string): Promise<unknown>;
}

export function createMemoryIdempotencyStore<R = unknown>(options?: { now?: () => number }): IdempotencyStore<R> & {
  get(id: string): IdempotencyRecord<R> | null;
  size(): number;
};

export type IdempotencyReason = 'invalid_key' | 'in_flight' | 'conflict' | 'unavailable';

export class IdempotencyError extends Error {
  reason: IdempotencyReason;
  statusCode: number;
  constructor(reason: IdempotencyReason, statusCode: number, message?: string);
}

export interface IdempotencyInput {
  /** At least the caller identity; the middleware adds method and path. */
  scope: Array<string | number>;
  key: string;
  payload?: unknown;
}

export type IdempotencyClaim<R = unknown> =
  | { action: 'replay'; response: R | null }
  | { action: 'execute'; id: string; finish(response: R): Promise<void>; abort(): Promise<void> };

export interface IdempotencyOptions<R = unknown> {
  store: IdempotencyStore<R>;
  /** Retention of a key, in ms. Default 24h. */
  ttlMs?: number;
  now?: () => number;
  keyPattern?: RegExp;
  messages?: Partial<Record<IdempotencyReason, string>>;
  logger?: { error(message: string): void; warn?(message: string): void };
}

export interface Idempotency<R = unknown> {
  begin(input: IdempotencyInput): Promise<IdempotencyClaim<R>>;
  run<T extends R>(
    input: IdempotencyInput,
    fn: () => T | Promise<T>,
    options?: { remember?: (result: T) => boolean }
  ): Promise<{ replayed: boolean; result: T }>;
  ttlMs: number;
}

export function createIdempotency<R = unknown>(options: IdempotencyOptions<R>): Idempotency<R>;

export interface IdempotencyMiddlewareOptions extends IdempotencyOptions<StoredIdempotentResponse> {
  /** REQUIRED: a STABLE, VERIFIED caller id (the account, not the token). null = shared anonymous namespace. */
  identify(req: RequestLike): string | number | null | undefined | Promise<string | number | null | undefined>;
  engine?: Idempotency<StoredIdempotentResponse>;
  header?: string;
  methods?: string[];
  replayHeader?: string;
  remember?: (statusCode: number) => boolean;
  /** Default 'deny' (503): no unguarded execution while the store is down. */
  onStoreError?: 'deny' | 'allow';
  respond?: (res: ResponseLike, payload: { status: number; reason: IdempotencyReason; message: string }) => unknown;
}

export function idempotencyMiddleware(options: IdempotencyMiddlewareOptions): RequestHandler;

export function decideIdempotency(input: {
  record: IdempotencyRecord | null;
  payloadHash: string;
  now?: number;
}): { action: 'execute' | 'expired' | 'conflict' | 'inFlight' } | { action: 'replay'; response: unknown };

export function hashIdempotencyPayload(payload: unknown): string;
export function isValidIdempotencyKey(key: unknown, pattern?: RegExp): boolean;
export const IDEMPOTENCY_TTL_MS: number;

/** Le jeton d'accès d'un compte de service Google (RFC 7523), sans google-auth-library. */
export interface GoogleServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
  [key: string]: unknown;
}
export interface GoogleServiceAccountAuthOptions {
  credentials: GoogleServiceAccountCredentials | string;
  /** Une ou plusieurs portées https://. */
  scopes: string[];
  /** Un compte à emprunter (délégation à l'échelle du domaine). */
  subject?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Délai de chaque appel à Google (15 000 ms). */
  timeoutMs?: number;
  /** Adresses d'échange permises à la place de googleapis.com (essais, émulateur). */
  allowedTokenUris?: string[];
}
export interface GoogleServiceAccountAuth {
  /** Gardé jusqu'à cinq minutes avant son échéance ; des demandes simultanées partagent un seul échange. */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  /** Un appel JSON à une API Google ; un 401 renouvelle le jeton et rejoue une fois. */
  request<T = unknown>(options: { method?: string; url: string; data?: unknown; headers?: Record<string, string>; signal?: AbortSignal }): Promise<{ status: number; data: T; headers: unknown }>;
  clientEmail: string;
  projectId?: string;
}
export function createGoogleServiceAccountAuth(options: GoogleServiceAccountAuthOptions): GoogleServiceAccountAuth;
export function readGoogleServiceAccount(credentials: GoogleServiceAccountCredentials | string, options?: { allowedTokenUris?: string[] }): { clientEmail: string; privateKey: import('node:crypto').KeyObject; tokenUri: string; projectId?: string };
export function signServiceAccountAssertion(account: { clientEmail: string; privateKey: import('node:crypto').KeyObject; tokenUri: string }, options: { scopes: string[]; subject?: string; nowSeconds?: number }): string;
/** https, sur googleapis.com ou un de ses sous-domaines, sans identifiants ni autre port. */
export function isGoogleTokenUri(value: string): boolean;
export class GoogleAuthError extends Error {
  code: 'GOOGLE_CREDENTIALS_INVALID' | 'GOOGLE_TOKEN_URI_REFUSED' | 'GOOGLE_SCOPES_INVALID' | 'GOOGLE_NO_FETCH' | 'GOOGLE_UNREACHABLE' | 'GOOGLE_TOKEN_REFUSED' | 'GOOGLE_URL_INVALID' | 'GOOGLE_API_ERROR';
  status?: number;
  httpStatus?: number;
  response?: { status: number; data: unknown };
}
export const GOOGLE_TOKEN_URI: string;

/** Le téléversement de fichiers (multipart/form-data), en mémoire, sans multer ni busboy. */
export interface UploadLimits {
  /** 10 Mio par défaut. */
  fileSize?: number;
  /** 10 par défaut. */
  files?: number;
  /** 100 par défaut. */
  fields?: number;
  /** 1 Mio par défaut. */
  fieldSize?: number;
  fieldNameSize?: number;
  /** 200 par défaut. */
  parts?: number;
  headerSize?: number;
  headerPairs?: number;
  /** 50 Mio par défaut. */
  totalSize?: number;
}
export interface UploadedFile {
  fieldname: string;
  /** Le nom donné par le client, sans son chemin. */
  originalname: string;
  /** Le même nom, sans caractère réservé, utilisable sur un disque. */
  safeName: string;
  encoding: string;
  /** Annoncé par le client : pas une preuve (voir detectFileType). */
  mimetype: string;
  size: number;
  buffer: Buffer;
}
export type UploadFileFilter =
  | ((req: any, file: Omit<UploadedFile, 'buffer' | 'size'> & { buffer?: Buffer; size?: number }, cb: (error: Error | null, accept?: boolean) => void) => void)
  | ((req: any, file: UploadedFile) => boolean | Promise<boolean>);
export interface Upload {
  single(name: string): RequestHandler;
  array(name: string, maxCount?: number): RequestHandler;
  fields(fields: Array<{ name: string; maxCount?: number }>): RequestHandler;
  none(): RequestHandler;
  any(): RequestHandler;
}
export function createUpload(options?: { limits?: UploadLimits; fileFilter?: UploadFileFilter }): Upload;
/** Le vrai type d'un fichier d'après ses premiers octets, ou null. */
export function detectFileType(buffer: Buffer): { ext: string; mime: string } | null;
export function safeFileName(name: string): string;
export class UploadError extends Error {
  code: 'LIMIT_PART_COUNT' | 'LIMIT_FILE_SIZE' | 'LIMIT_FILE_COUNT' | 'LIMIT_FIELD_KEY' | 'LIMIT_FIELD_VALUE' | 'LIMIT_FIELD_COUNT' | 'LIMIT_UNEXPECTED_FILE' | 'LIMIT_TOTAL_SIZE' | 'MISSING_FIELD_NAME' | 'FIELD_NAME_FORBIDDEN' | 'MALFORMED' | 'UNEXPECTED_END' | 'HEADER_TOO_LARGE';
  field?: string;
  status: number;
  statusCode: number;
}
export const UPLOAD_DEFAULT_LIMITS: Required<UploadLimits>;

/* La validation des requêtes par chaînes (comme express-validator 7). */
export type ValidationLocation = 'body' | 'cookies' | 'headers' | 'params' | 'query';
export interface FieldValidationError {
  type: 'field';
  /** Absent avec hide(), remplacé avec hide(valeur). */
  value?: unknown;
  msg: unknown;
  path: string;
  location: ValidationLocation;
}
export interface FieldMeta {
  req: any;
  location: ValidationLocation;
  path: string;
  pathValues: unknown[];
}
export type FieldMessage = unknown | ((value: unknown, meta: FieldMeta) => unknown);
export interface ValidationResult {
  array(options?: { onlyFirstError?: boolean }): FieldValidationError[];
  mapped(): Record<string, FieldValidationError>;
  formatWith<T>(formatter: (error: FieldValidationError) => T): { array(options?: { onlyFirstError?: boolean }): T[]; mapped(): Record<string, T>; isEmpty(): boolean; throw(): void };
  isEmpty(): boolean;
  throw(): void;
}
export interface ValidationChain {
  (req: any, res: any, next: (error?: unknown) => void): Promise<void>;
  run(req: any, options?: { dryRun?: boolean }): Promise<ValidationResult>;
  not(): ValidationChain;
  withMessage(message: FieldMessage): ValidationChain;
  custom(validator: (value: any, meta: FieldMeta) => unknown): ValidationChain;
  exists(options?: { values?: 'undefined' | 'null' | 'falsy'; checkNull?: boolean; checkFalsy?: boolean }): ValidationChain;
  optional(options?: boolean | { values?: 'undefined' | 'null' | 'falsy'; nullable?: boolean; checkFalsy?: boolean }): ValidationChain;
  bail(options?: { level?: 'chain' | 'request' }): ValidationChain;
  if(condition: ValidationChain | ((value: any, meta: FieldMeta) => unknown)): ValidationChain;
  hide(hiddenValue?: string): ValidationChain;
  isArray(options?: { min?: number; max?: number }): ValidationChain;
  isObject(options?: { strict?: boolean }): ValidationChain;
  isString(): ValidationChain;
  isBoolean(options?: { strict?: boolean; loose?: boolean }): ValidationChain;
  notEmpty(options?: { ignore_whitespace?: boolean }): ValidationChain;
  isEmpty(options?: { ignore_whitespace?: boolean }): ValidationChain;
  contains(elem: unknown, options?: { ignoreCase?: boolean; minOccurrences?: number }): ValidationChain;
  equals(comparison: string): ValidationChain;
  isByteLength(options?: { min?: number; max?: number }): ValidationChain;
  isEmail(options?: { allow_display_name?: boolean; require_display_name?: boolean; allow_utf8_local_part?: boolean; require_tld?: boolean; allow_ip_domain?: boolean; domain_specific_validation?: boolean; blacklisted_chars?: string; host_blacklist?: (string | RegExp)[]; host_whitelist?: (string | RegExp)[]; ignore_max_length?: boolean; allow_underscores?: boolean }): ValidationChain;
  isFQDN(options?: { require_tld?: boolean; allow_underscores?: boolean; allow_trailing_dot?: boolean; allow_numeric_tld?: boolean; allow_wildcard?: boolean; ignore_max_length?: boolean }): ValidationChain;
  isFloat(options?: { min?: number; max?: number; gt?: number; lt?: number; locale?: string }): ValidationChain;
  isHexadecimal(): ValidationChain;
  isIP(version?: 4 | 6 | '4' | '6'): ValidationChain;
  isIn(values: readonly unknown[] | Record<string, unknown> | string): ValidationChain;
  isInt(options?: { min?: number; max?: number; gt?: number; lt?: number; allow_leading_zeroes?: boolean }): ValidationChain;
  isLength(options?: { min?: number; max?: number; discreteLengths?: number[] }): ValidationChain;
  isMongoId(): ValidationChain;
  isNumeric(options?: { no_symbols?: boolean; locale?: string }): ValidationChain;
  isUUID(version?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 'all' | 'nil' | 'max' | 'loose' | string | number): ValidationChain;
  matches(pattern: RegExp | string, modifiers?: string): ValidationChain;
  trim(chars?: string): ValidationChain;
  ltrim(chars?: string): ValidationChain;
  rtrim(chars?: string): ValidationChain;
  escape(): ValidationChain;
  unescape(): ValidationChain;
  normalizeEmail(options?: Record<string, boolean>): ValidationChain;
  stripLow(keepNewLines?: boolean): ValidationChain;
  toBoolean(strict?: boolean): ValidationChain;
  toDate(): ValidationChain;
  toFloat(): ValidationChain;
  toInt(radix?: number): ValidationChain;
  blacklist(chars: string): ValidationChain;
  whitelist(chars: string): ValidationChain;
  toLowerCase(): ValidationChain;
  toUpperCase(): ValidationChain;
  toArray(): ValidationChain;
  default(value: unknown): ValidationChain;
  replace(valuesToReplace: unknown, newValue: unknown): ValidationChain;
  customSanitizer(sanitizer: (value: any, meta: FieldMeta) => unknown): ValidationChain;
}
export type ValidationChainFactory = (fields?: string | string[], message?: FieldMessage) => ValidationChain;
export const body: ValidationChainFactory;
export const param: ValidationChainFactory;
export const query: ValidationChainFactory;
export const header: ValidationChainFactory;
export const cookie: ValidationChainFactory;
export const check: ValidationChainFactory;
export const validationResult: ((req: any) => ValidationResult) & { withDefaults<T>(options?: { formatter?: (error: FieldValidationError) => T }): (req: any) => ValidationResult };
export function matchedData(req: any, options?: { onlyValidData?: boolean; includeOptionals?: boolean; locations?: ValidationLocation[] }): Record<string, any>;
export class Result implements ValidationResult {
  array(options?: { onlyFirstError?: boolean }): FieldValidationError[];
  mapped(): Record<string, FieldValidationError>;
  formatWith<T>(formatter: (error: FieldValidationError) => T): any;
  isEmpty(): boolean;
  throw(): void;
}
