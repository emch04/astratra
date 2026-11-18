import http from 'node:http';
import { createMcpServer, createMcpClient, createStreamableHttpClientTransport, createStreamableHttpHandler, createStdioServerTransport, createInMemoryTransportPair, McpError, type CallToolResult } from './src/index';

async function exercise(): Promise<void> {
  const server = createMcpServer({ name: 'outils', version: '1.0.0' }, { instructions: 'Lis-moi.' })
    .tool({ name: 'addition', description: 'Additionne', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }, annotations: { readOnlyHint: true } }, async ({ a, b }) => String(a + b));
  await server.connect(createStdioServerTransport());
  const handler = createStreamableHttpHandler({ createServer: () => createMcpServer({ name: 'h', version: '1' }), allowedOrigins: ['https://app.example'] });
  http.createServer(handler);
  const client = createMcpClient({ name: 'c', version: '1' }, { timeoutMs: 10_000 });
  await client.connect(createStreamableHttpClientTransport('https://mcp.example/mcp', { headers: { Authorization: 'Bearer x' } }));
  const tools = await client.listAllTools();
  const result: CallToolResult = await client.callTool({ name: tools[0].name, arguments: {} }, { signal: AbortSignal.timeout(5000) });
  const [a, b] = createInMemoryTransportPair();
  void [result.isError, a, b, client.getInstructions(), handler.sessionCount, new McpError(-32602, 'x').rawMessage];
}

void exercise;
