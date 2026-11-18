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
