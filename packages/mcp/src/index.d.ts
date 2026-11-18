export const LATEST_PROTOCOL_VERSION: '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION: '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS: string[];
export const ErrorCode: { readonly ConnectionClosed: -32000; readonly RequestTimeout: -32001; readonly ParseError: -32700; readonly InvalidRequest: -32600; readonly MethodNotFound: -32601; readonly InvalidParams: -32602; readonly InternalError: -32603 };

export class McpError extends Error {
  constructor(code: number, message: string, data?: unknown);
  code: number;
  /** The message without the "MCP error <code>: " prefix. */
  rawMessage: string;
  data?: unknown;
  /** Set when an HTTP transport received a non-2xx status. */
  status?: number;
}

export type JsonRpcId = string | number;
export interface JsonRpcRequest { jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: Record<string, any> }
export interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: Record<string, any> }
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | { jsonrpc: '2.0'; id: JsonRpcId; result: Record<string, any> } | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };
export function messageKind(message: unknown): 'request' | 'notification' | 'response' | 'error' | null;

/** Shaped like the official SDK's transports: an SDK transport plugs in as is. */
export interface Transport {
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: ((message: any) => void) | null;
  onclose?: (() => void) | null;
  onerror?: ((error: Error) => void) | null;
  sessionId?: string;
  setProtocolVersion?(version: string): void;
}

export interface RequestExtra {
  signal: AbortSignal;
  requestId: JsonRpcId;
  sessionId?: string;
  sendNotification(notification: { method: string; params?: Record<string, any> }): Promise<void>;
}
export interface RequestOptions { timeoutMs?: number; signal?: AbortSignal }
export function createSession(options: { onRequest: (request: JsonRpcRequest, extra: RequestExtra) => Promise<Record<string, any>>; onNotification?: (notification: JsonRpcNotification) => void; onError?: (error: Error) => void; onClose?: () => void }): {
  connect(transport: Transport): Promise<void>;
  request(method: string, params?: Record<string, any>, options?: RequestOptions): Promise<any>;
  notify(method: string, params?: Record<string, any>): Promise<void>;
  close(): Promise<void>;
  readonly transport: Transport | null;
};

export interface ToolDefinition {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: Record<string, any>;
  outputSchema?: Record<string, any>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  [key: string]: unknown;
}
export interface ContentPart { type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown }
export interface CallToolResult { content: ContentPart[]; structuredContent?: Record<string, any>; isError?: boolean; [key: string]: unknown }

export interface McpServer {
  setRequestHandler(method: string, handler: (request: JsonRpcRequest, extra: RequestExtra) => Promise<Record<string, any>> | Record<string, any>): McpServer;
  /** A tool: its handler returns an MCP result or a text. */
  tool(definition: ToolDefinition, handler: (args: Record<string, any>, extra: RequestExtra) => Promise<CallToolResult | string> | CallToolResult | string): McpServer;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  getClientVersion(): { name: string; version: string } | null;
  getClientCapabilities(): Record<string, any> | null;
  readonly protocolVersion: string | null;
  oninitialized: (() => void) | null;
  onerror: ((error: Error) => void) | null;
  onclose: (() => void) | null;
}
export function createMcpServer(info: { name: string; version: string; title?: string }, options?: { capabilities?: Record<string, any>; instructions?: string }): McpServer;
export function checkArguments(schema: Record<string, any> | undefined, args: unknown): string | null;

export interface McpClient {
  connect(transport: Transport, options?: { timeoutMs?: number }): Promise<void>;
  listTools(params?: { cursor?: string }, options?: RequestOptions): Promise<{ tools: ToolDefinition[]; nextCursor?: string }>;
  listAllTools(options?: RequestOptions & { maxPages?: number }): Promise<ToolDefinition[]>;
  callTool(params: { name: string; arguments?: Record<string, any> }, options?: RequestOptions): Promise<CallToolResult>;
  ping(options?: RequestOptions): Promise<Record<string, never>>;
  request(method: string, params?: Record<string, any>, options?: RequestOptions): Promise<any>;
  close(): Promise<void>;
  getServerVersion(): { name: string; version: string; [key: string]: unknown } | null;
  getServerCapabilities(): Record<string, any> | null;
  getInstructions(): string | null;
  readonly protocolVersion: string | null;
  onerror: ((error: Error) => void) | null;
  onclose: (() => void) | null;
}
export function createMcpClient(info?: { name: string; version: string }, options?: { capabilities?: Record<string, any>; timeoutMs?: number }): McpClient;

export function createInMemoryTransportPair(): [Transport, Transport];
export function createStdioServerTransport(options?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; maxMessageBytes?: number }): Transport;
export function createStreamableHttpClientTransport(url: string | URL, options?: { headers?: Record<string, string>; fetch?: typeof fetch; maxMessageBytes?: number; maxStreamBytes?: number }): Transport & { readonly sessionId: string | undefined };
export interface StreamableHttpHandler {
  (req: import('node:http').IncomingMessage & { body?: unknown }, res: import('node:http').ServerResponse): Promise<void>;
  closeAll(): Promise<void>;
  readonly sessionCount: number;
}
export function createStreamableHttpHandler(options: { createServer: () => McpServer; allowedOrigins?: string[]; maxBodyBytes?: number; maxSessions?: number; sessionIdleMs?: number; requestTimeoutMs?: number }): StreamableHttpHandler;
export function readServerSentEvents(body: ReadableStream<Uint8Array>, options?: { maxEventBytes?: number; maxStreamBytes?: number }): AsyncGenerator<{ event: string; data: string; id?: string }>;
