import type { WebSearch } from './index';

/** Un serveur MCP (SDK officiel, serveur bas niveau) qui sert web_search et read_page. Brancher avec `server.connect(transport)`. */
export function createMcpServer(ws: WebSearch, options?: { name?: string; version?: string; defaults?: { limit?: number; read?: number }; maxChars?: number }): {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
};
