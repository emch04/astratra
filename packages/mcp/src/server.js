const { createSession, McpError, ErrorCode, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } = require('./jsonrpc');

/*
 * Un serveur MCP : la poignée de main (initialize), ping, et les méthodes données par setRequestHandler — ou des outils
 * déclarés avec tool(), qui servent tools/list et tools/call tout seuls. Il remplace Server et McpServer du SDK pour
 * ces usages.
 *
 * Différences voulues avec le SDK :
 *   - une exception levée par un traitement revient en « Internal error », sans son message (qui peut contenir un
 *     chemin, une requête SQL, une clé) ; une McpError garde son code et son message ;
 *   - avec tool(), une exception de l'outil revient en résultat isError: true avec un message générique (McpServer
 *     renvoyait le message de l'exception) ; les arguments sont vérifiés contre le schéma de l'outil (objet,
 *     required, type et enum des propriétés) avant l'appel ;
 *   - initialize ou tools/call sans les paramètres requis répond -32602 avec un message clair (le SDK répondait
 *     -32603 avec le vidage de son schéma) ; un curseur inconnu est refusé (-32602), comme le demande la
 *     spécification ; capabilities.tools.listChanged vaut false (la liste ne change pas après la connexion).
 */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const PAGE = 100;

/** Une vérification simple d'arguments contre un schéma JSON d'outil (objet, required, type des propriétés). */
function checkArguments(schema, args) {
  if (!isPlainObject(args)) return 'arguments must be an object';
  if (!isPlainObject(schema)) return null;
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (!Object.hasOwn(args, name)) return `missing required argument "${name}"`;
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [name, value] of Object.entries(args)) {
    const property = Object.hasOwn(properties, name) ? properties[name] : null;
    if (!property) {
      if (schema.additionalProperties === false) return `unknown argument "${name}"`;
      continue;
    }
    const types = Array.isArray(property.type) ? property.type : property.type ? [property.type] : [];
    if (!types.length) continue;
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) return `argument "${name}" must be ${types.join(' or ')}`;
    if (Array.isArray(property.enum) && !property.enum.some((e) => e === value)) return `argument "${name}" must be one of ${property.enum.map((e) => JSON.stringify(e)).join(', ')}`;
  }
  return null;
}

/**
 * @param {object} info  { name, version, title? }
 * @param {object} [options]  { capabilities, instructions }
 */
function createMcpServer(info = {}, options = {}) {
  if (typeof info.name !== 'string' || !info.name || typeof info.version !== 'string' || !info.version) throw new TypeError('createMcpServer needs { name, version }');
  const handlers = new Map();
  const tools = new Map();
  const capabilities = { ...(options.capabilities || {}) };
  let session = null;
  let clientInfo = null;
  let clientCapabilities = null;
  let protocolVersion = null;
  let oninitialized = null;

  const server = {
    /** Une méthode JSON-RPC : handler(request, extra) rend le résultat (objet) ou lève. */
    setRequestHandler(method, handler) {
      if (typeof method !== 'string' || typeof handler !== 'function') throw new TypeError('setRequestHandler(method, handler)');
      if (method === 'initialize' || method === 'ping') throw new Error(`${method} is handled by the server`);
      if (method.startsWith('tools/') && !capabilities.tools) throw new Error('Server does not support tools (declare capabilities.tools)');
      handlers.set(method, handler);
      return server;
    },

    /**
     * Un outil : { name, description, inputSchema, annotations?, title?, outputSchema? }, et handler(args, extra) qui
     * rend un résultat MCP ({ content: [...] }) ou un texte.
     */
    tool(definition, handler) {
      if (!isPlainObject(definition) || !TOOL_NAME.test(definition.name || '')) throw new TypeError('tool needs a name of letters, digits, "_", "-" or "." (128 at most)');
      if (typeof handler !== 'function') throw new TypeError('tool needs a handler');
      if (tools.has(definition.name)) throw new Error(`tool ${definition.name} is already registered`);
      const inputSchema = isPlainObject(definition.inputSchema) ? definition.inputSchema : { type: 'object', properties: {} };
      tools.set(definition.name, { definition: { ...definition, inputSchema }, handler });
      if (!capabilities.tools) capabilities.tools = { listChanged: false };
      if (!handlers.has('tools/list')) {
        handlers.set('tools/list', async (request) => {
          const all = [...tools.values()].map((t) => t.definition);
          const start = request.params?.cursor === undefined ? 0 : Number.parseInt(String(request.params.cursor), 10);
          if (!Number.isSafeInteger(start) || start < 0 || start > all.length) throw new McpError(ErrorCode.InvalidParams, 'Invalid cursor');
          const page = all.slice(start, start + PAGE);
          return { tools: page, ...(start + PAGE < all.length ? { nextCursor: String(start + PAGE) } : {}) };
        });
        handlers.set('tools/call', async (request, extra) => {
          const name = request.params?.name;
          if (typeof name !== 'string') throw new McpError(ErrorCode.InvalidParams, 'Invalid params: name is required');
          // Comme McpServer du SDK : un outil inconnu ou des arguments invalides reviennent en résultat isError, pour que
          // le modèle se corrige (spécification MCP 2025-11-25, erreurs d'exécution d'outil).
          const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });
          const entry = tools.get(name);
          if (!entry) return toolError(`MCP error -32602: Tool ${String(name).slice(0, 128)} not found`);
          const given = request.params.arguments === undefined ? {} : request.params.arguments;
          const problem = checkArguments({ ...entry.definition.inputSchema, additionalProperties: true }, given);
          if (problem) return toolError(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}: ${problem}`);
          // Un argument hors du schéma (additionalProperties: false) est retiré avant l'appel, comme le fait le SDK.
          const schema = entry.definition.inputSchema;
          const args = schema.additionalProperties === false && isPlainObject(schema.properties) ? Object.fromEntries(Object.entries(given).filter(([k]) => Object.hasOwn(schema.properties, k))) : given;
          try {
            const result = await entry.handler(args, extra);
            if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
            return isPlainObject(result) ? result : { content: [] };
          } catch (error) {
            if (extra.signal.aborted) throw error;
            if (error instanceof McpError) throw error;
            return { isError: true, content: [{ type: 'text', text: `Tool ${name} failed` }] };
          }
        });
      }
      return server;
    },

    async connect(transport) {
      if (session) throw new Error('already connected');
      session = createSession({
        onRequest: async (request, extra) => {
          if (request.method === 'initialize') {
            const params = request.params;
            if (!isPlainObject(params) || typeof params.protocolVersion !== 'string') throw new McpError(ErrorCode.InvalidParams, 'Invalid params: initialize needs params.protocolVersion');
            const requested = params.protocolVersion;
            protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
            clientInfo = isPlainObject(params.clientInfo) ? params.clientInfo : null;
            clientCapabilities = isPlainObject(params.capabilities) ? params.capabilities : null;
            return { protocolVersion, capabilities, serverInfo: { ...info }, ...(options.instructions ? { instructions: options.instructions } : {}) };
          }
          if (request.method === 'ping') return {};
          const handler = handlers.get(request.method);
          if (!handler) throw new McpError(ErrorCode.MethodNotFound, 'Method not found');
          return handler(request, extra);
        },
        onNotification: (notification) => {
          if (notification.method === 'notifications/initialized') oninitialized?.();
        },
        onError: (error) => server.onerror?.(error),
        onClose: () => server.onclose?.(),
      });
      await session.connect(transport);
    },

    async close() {
      if (session) await session.close();
    },

    getClientVersion: () => clientInfo,
    getClientCapabilities: () => clientCapabilities,
    get protocolVersion() {
      return protocolVersion;
    },
    set oninitialized(fn) {
      oninitialized = fn;
    },
    onerror: null,
    onclose: null,
  };
  return server;
}

module.exports = { createMcpServer, checkArguments };
