const { createSession, McpError, ErrorCode, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } = require('./jsonrpc');

/*
 * Un client MCP : la poignée de main (initialize puis notifications/initialized), la liste des outils page après
 * page, l'appel d'un outil avec délai et annulation, ping. Il remplace Client du SDK pour ces usages.
 *
 * Le client ne sert aucune requête du serveur (ni sampling, ni elicitation, ni roots) : il n'en annonce pas la
 * capacité, et répond « Method not found » à une requête que le serveur enverrait quand même, sauf ping.
 */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object} [info]  { name, version } annoncés au serveur
 * @param {object} [options]  { capabilities, timeoutMs (défaut 60 s par requête) }
 */
function createMcpClient(info = { name: 'astratra-mcp', version: '1.0.0' }, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  let session = null;
  let serverInfo = null;
  let serverCapabilities = null;
  let instructions = null;
  let protocolVersion = null;

  const client = {
    async connect(transport, { timeoutMs: connectTimeout = timeoutMs } = {}) {
      if (session) throw new Error('already connected');
      session = createSession({
        onRequest: async (request) => {
          if (request.method === 'ping') return {};
          throw new McpError(ErrorCode.MethodNotFound, 'Method not found');
        },
        onError: (error) => client.onerror?.(error),
        onClose: () => client.onclose?.(),
      });
      await session.connect(transport);
      try {
        const result = await session.request('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: options.capabilities || {}, clientInfo: { name: info.name, version: info.version } }, { timeoutMs: connectTimeout });
        if (!isPlainObject(result) || !SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) throw new Error(`Server's protocol version is not supported: ${isPlainObject(result) ? String(result.protocolVersion).slice(0, 40) : 'none'}`);
        protocolVersion = result.protocolVersion;
        serverInfo = isPlainObject(result.serverInfo) ? result.serverInfo : null;
        serverCapabilities = isPlainObject(result.capabilities) ? result.capabilities : {};
        instructions = typeof result.instructions === 'string' ? result.instructions : null;
        if (typeof transport.setProtocolVersion === 'function') transport.setProtocolVersion(protocolVersion);
        await session.notify('notifications/initialized');
      } catch (error) {
        await client.close();
        throw error;
      }
    },

    /** Une page d'outils : { tools, nextCursor }. */
    async listTools(params = {}, requestOptions = {}) {
      if (!serverCapabilities?.tools) throw new McpError(ErrorCode.MethodNotFound, 'Server does not support tools');
      const result = await session.request('tools/list', params.cursor === undefined ? undefined : { cursor: params.cursor }, { timeoutMs, ...requestOptions });
      if (!isPlainObject(result) || !Array.isArray(result.tools)) throw new McpError(ErrorCode.InvalidRequest, 'Invalid tools/list result');
      return { tools: result.tools.filter((t) => isPlainObject(t) && typeof t.name === 'string'), ...(typeof result.nextCursor === 'string' ? { nextCursor: result.nextCursor } : {}) };
    },

    /** Tous les outils, page après page (au plus maxPages, 100 par défaut ; un curseur qui se répète arrête la boucle). */
    async listAllTools({ maxPages = 100, ...requestOptions } = {}) {
      const all = [];
      const seen = new Set();
      let cursor;
      for (let page = 0; page < maxPages; page++) {
        const result = await client.listTools(cursor === undefined ? {} : { cursor }, requestOptions);
        all.push(...result.tools);
        cursor = result.nextCursor;
        if (cursor === undefined) return all;
        if (seen.has(cursor)) throw new McpError(ErrorCode.InvalidRequest, 'tools/list returned the same cursor twice');
        seen.add(cursor);
      }
      throw new McpError(ErrorCode.InvalidRequest, `tools/list has more than ${maxPages} pages`);
    },

    /** Appelle un outil : { content, structuredContent?, isError? }. `timeoutMs` et `signal` par appel. */
    async callTool({ name, arguments: args = {} }, requestOptions = {}) {
      if (typeof name !== 'string' || !name) throw new TypeError('callTool needs a tool name');
      if (!isPlainObject(args)) throw new TypeError('callTool arguments must be an object');
      const result = await session.request('tools/call', { name, arguments: args }, { timeoutMs, ...requestOptions });
      if (!isPlainObject(result)) throw new McpError(ErrorCode.InvalidRequest, 'Invalid tools/call result');
      return { ...result, content: Array.isArray(result.content) ? result.content : [] };
    },

    async ping(requestOptions = {}) {
      return session.request('ping', undefined, { timeoutMs, ...requestOptions });
    },

    /** Une autre méthode JSON-RPC (resources/list, prompts/get…), sans vérification du résultat. */
    async request(method, params, requestOptions = {}) {
      return session.request(method, params, { timeoutMs, ...requestOptions });
    },

    async close() {
      const current = session;
      if (!current) return;
      await current.close().catch(() => {});
    },

    getServerVersion: () => serverInfo,
    getServerCapabilities: () => serverCapabilities,
    getInstructions: () => instructions,
    get protocolVersion() {
      return protocolVersion;
    },
    onerror: null,
    onclose: null,
  };
  return client;
}

module.exports = { createMcpClient };
