import type { WebSearch } from './index';

/**
 * Un serveur MCP (SDK officiel, serveur bas niveau) qui sert web_search et read_page, et browse_page et search_site quand le
 * navigateur est branché. screenshots : le client lit les images (capture rendue en contenu image). Brancher avec `server.connect(transport)`.
 */
export function createMcpServer(ws: WebSearch, options?: { name?: string; version?: string; defaults?: { limit?: number; read?: number }; maxChars?: number; browser?: boolean; screenshots?: boolean }): {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
};
