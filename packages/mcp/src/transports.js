/* global AbortController, TextDecoder, queueMicrotask */
const crypto = require('node:crypto');
const { messageKind, McpError, ErrorCode, SUPPORTED_PROTOCOL_VERSIONS } = require('./jsonrpc');

/*
 * Les transports MCP, à la forme de ceux du SDK (start, send, close ; onmessage, onclose, onerror) :
 *   - createInMemoryTransportPair : deux bouts reliés, pour les essais ;
 *   - createStdioServerTransport : un message JSON par ligne sur stdin et stdout (un éditeur lance le serveur) ;
 *   - createStreamableHttpClientTransport : le client « Streamable HTTP » (POST, réponse JSON ou flux SSE, session) ;
 *   - createStreamableHttpHandler : le serveur « Streamable HTTP », un gestionnaire (req, res) pour node:http ou
 *     Express, une session par client.
 *
 * Protections : l'adresse d'un serveur distant doit être en https:// (http:// seulement vers la machine), sans
 * identifiants ; aucune redirection suivie ; un message de 4 Mio au plus, un flux de 16 Mio au plus ; côté serveur,
 * l'en-tête Origin est vérifié (une page web ne peut pas parler au serveur sans être permise : attaque de « DNS
 * rebinding »), le corps est plafonné, les sessions sont limitées en nombre et en durée d'inactivité.
 */

const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_STREAM = 16 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const SESSION_ID = /^[\x21-\x7e]{1,256}$/;

const parseJson = (text) => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/** Deux bouts reliés : ce qu'envoie l'un, l'autre le reçoit (copié, comme sur un vrai fil). */
function createInMemoryTransportPair() {
  const make = () => ({ other: null, closed: false, onmessage: null, onclose: null, onerror: null });
  const a = make();
  const b = make();
  a.other = b;
  b.other = a;
  for (const side of [a, b]) {
    side.start = async () => {};
    side.send = async (message) => {
      if (side.closed) throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
      const copy = JSON.parse(JSON.stringify(message));
      queueMicrotask(() => side.other.onmessage?.(copy));
    };
    side.close = async () => {
      for (const s of [side, side.other]) {
        if (s.closed) continue;
        s.closed = true;
        s.onclose?.();
      }
    };
  }
  return [a, b];
}

/** Le serveur en stdio : une ligne JSON par message. */
function createStdioServerTransport({ stdin = process.stdin, stdout = process.stdout, maxMessageBytes = MAX_MESSAGE } = {}) {
  let buffer = '';
  let started = false;
  const transport = {
    onmessage: null,
    onclose: null,
    onerror: null,
    async start() {
      if (started) throw new Error('already started');
      started = true;
      stdin.setEncoding?.('utf8');
      stdin.on('data', onData);
      stdin.on('error', onError);
      stdin.on('end', onEnd);
    },
    async send(message) {
      const line = `${JSON.stringify(message)}\n`;
      if (!stdout.write(line)) await new Promise((resolve) => stdout.once('drain', resolve));
    },
    async close() {
      stdin.off('data', onData);
      stdin.off('error', onError);
      stdin.off('end', onEnd);
      stdin.pause?.();
      buffer = '';
      transport.onclose?.();
    },
  };
  function onData(chunk) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const parsed = parseJson(line);
      if (!parsed.ok) transport.onerror?.(new McpError(ErrorCode.ParseError, 'Parse error'));
      else transport.onmessage?.(parsed.value);
    }
    if (Buffer.byteLength(buffer) > maxMessageBytes) {
      buffer = '';
      transport.onerror?.(new McpError(ErrorCode.InvalidRequest, `message larger than ${maxMessageBytes} bytes`));
    }
  }
  function onError(error) {
    transport.onerror?.(error);
  }
  function onEnd() {
    transport.close().catch(() => {});
  }
  return transport;
}

/** Lit un flux SSE (text/event-stream) et rend chaque événement { event, data, id }. */
async function* readServerSentEvents(body, { maxEventBytes = MAX_MESSAGE, maxStreamBytes = MAX_STREAM } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  let event = { event: 'message', data: [], id: undefined };
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxStreamBytes) throw new McpError(ErrorCode.InvalidRequest, `stream larger than ${maxStreamBytes} bytes`);
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1));
        if (line === '') {
          if (event.data.length) yield { event: event.event, data: event.data.join('\n'), id: event.id };
          event = { event: 'message', data: [], id: undefined };
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let content = colon < 0 ? '' : line.slice(colon + 1);
        if (content.startsWith(' ')) content = content.slice(1);
        if (field === 'data') {
          event.data.push(content);
          if (event.data.reduce((n, d) => n + d.length, 0) > maxEventBytes) throw new McpError(ErrorCode.InvalidRequest, `event larger than ${maxEventBytes} bytes`);
        } else if (field === 'event') event.event = content;
        else if (field === 'id' && !content.includes('\0')) event.id = content;
      }
      if (buffer.length > maxEventBytes) throw new McpError(ErrorCode.InvalidRequest, `line larger than ${maxEventBytes} bytes`);
    }
    if (event.data.length) yield { event: event.event, data: event.data.join('\n'), id: event.id };
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new McpError(ErrorCode.InvalidRequest, `response larger than ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

function checkUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('MCP server url must be a URL');
  }
  if (parsed.username || parsed.password) throw new TypeError('MCP server url must not contain credentials (use headers)');
  if (parsed.protocol === 'http:' && !LOOPBACK.has(parsed.hostname)) throw new TypeError('MCP server url must use https:// (http:// only to this machine)');
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError('MCP server url must use https://');
  return parsed;
}

const MANAGED = new Set(['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'content-length', 'host']);

/**
 * Le client « Streamable HTTP ».
 * @param {string|URL} url
 * @param {object} [options]  { headers, fetch, maxMessageBytes, maxStreamBytes }
 */
function createStreamableHttpClientTransport(url, options = {}) {
  const endpoint = checkUrl(url);
  const fetchFn = options.fetch || globalThis.fetch;
  const extra = {};
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (MANAGED.has(name.toLowerCase())) throw new TypeError(`header ${name} is set by the transport`);
    if (/[\r\n]/.test(String(value))) throw new TypeError(`header ${name} has a line break`);
    extra[name] = String(value);
  }
  const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE;
  const maxStreamBytes = options.maxStreamBytes ?? MAX_STREAM;
  let controller = new AbortController();
  let sessionId;
  let protocolVersion;
  let closed = false;

  const headers = (more) => ({ ...extra, ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}), ...more });
  const deliver = (value) => {
    for (const message of Array.isArray(value) ? value : [value]) transport.onmessage?.(message);
  };

  const transport = {
    onmessage: null,
    onclose: null,
    onerror: null,
    async start() {},
    setProtocolVersion(version) {
      protocolVersion = version;
    },
    get sessionId() {
      return sessionId;
    },
    async send(message) {
      if (closed) throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
      const response = await fetchFn(endpoint, { method: 'POST', headers: headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }), body: JSON.stringify(message), redirect: 'manual', signal: controller.signal });
      const newSession = response.headers.get('mcp-session-id');
      if (newSession) {
        if (!SESSION_ID.test(newSession)) throw new McpError(ErrorCode.InvalidRequest, 'Invalid session id from server');
        sessionId = newSession;
      }
      if (response.status === 202) {
        response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok) {
        const text = await readLimited(response, 64 * 1024).catch(() => '');
        if (response.status === 404 && sessionId) sessionId = undefined;
        const parsed = parseJson(text);
        const detail = parsed.ok && parsed.value?.error?.message ? `: ${String(parsed.value.error.message).slice(0, 200)}` : '';
        const error = new McpError(ErrorCode.ConnectionClosed, `HTTP ${response.status} from MCP server${detail}`);
        error.status = response.status;
        throw error;
      }
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type === 'application/json') {
        const parsed = parseJson(await readLimited(response, maxMessageBytes));
        if (!parsed.ok) throw new McpError(ErrorCode.ParseError, 'Invalid JSON from MCP server');
        deliver(parsed.value);
        return;
      }
      if (type === 'text/event-stream') {
        const expected = messageKind(message) === 'request' ? message.id : undefined;
        // Le flux est lu sans bloquer l'envoi : la réponse arrive par onmessage. Si le flux d'une requête casse ou se
        // termine sans sa réponse, la requête échoue tout de suite (au lieu d'attendre son délai).
        const failRequest = (message2) => {
          if (expected !== undefined && !closed) transport.onmessage?.({ jsonrpc: '2.0', id: expected, error: { code: ErrorCode.ConnectionClosed, message: message2 } });
        };
        (async () => {
          for await (const event of readServerSentEvents(response.body, { maxEventBytes: maxMessageBytes, maxStreamBytes })) {
            if (event.event !== 'message') continue;
            const parsed = parseJson(event.data);
            if (!parsed.ok) {
              transport.onerror?.(new McpError(ErrorCode.ParseError, 'Invalid JSON in event stream'));
              continue;
            }
            deliver(parsed.value);
            if (expected !== undefined && (Array.isArray(parsed.value) ? parsed.value : [parsed.value]).some((m) => m && m.id === expected && ('result' in m || 'error' in m))) return;
          }
          failRequest('Event stream ended without a response');
        })().catch((error) => {
          if (closed) return;
          transport.onerror?.(error);
          failRequest(error instanceof McpError ? error.rawMessage : 'Event stream failed');
        });
        return;
      }
      response.body?.cancel().catch(() => {});
      throw new McpError(ErrorCode.InvalidRequest, `Unexpected content type from MCP server: ${type.slice(0, 60)}`);
    },
    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      // La session est fermée chez le serveur (spécification MCP : DELETE quand le client n'en a plus besoin).
      if (sessionId) {
        const goodbye = new AbortController();
        const timer = setTimeout(() => goodbye.abort(), 5000);
        timer.unref?.();
        await fetchFn(endpoint, { method: 'DELETE', headers: headers({}), redirect: 'manual', signal: goodbye.signal })
          .then((r) => r.body?.cancel())
          .catch(() => {})
          .finally(() => clearTimeout(timer));
      }
      controller = new AbortController();
      transport.onclose?.();
    },
  };
  return transport;
}

/** Le transport d'une session côté serveur HTTP : chaque réponse va à la requête HTTP qui attend son id. */
function sessionTransport() {
  const waiting = new Map();
  return {
    onmessage: null,
    onclose: null,
    onerror: null,
    sessionId: undefined,
    waiting,
    async start() {},
    async send(message) {
      const resolve = message && message.id !== undefined ? waiting.get(message.id) : undefined;
      if (resolve) {
        waiting.delete(message.id);
        resolve(message);
      }
      // Une notification du serveur hors d'une réponse est ignorée : pas de flux GET ouvert.
    },
    async close() {
      for (const resolve of waiting.values()) resolve(null);
      waiting.clear();
      this.onclose?.();
    },
  };
}

function readBody(req, limit) {
  if (req.body !== undefined) return Promise.resolve(typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // La lecture s'arrête ici ; la connexion est fermée une fois la réponse 413 partie.
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Le serveur « Streamable HTTP » : (req, res) pour node:http ou Express. `createServer()` rend un serveur MCP neuf
 * (createMcpServer) pour chaque session.
 * @param {object} options  { createServer, allowedOrigins = [], maxBodyBytes = 4 Mio, maxSessions = 1000,
 *   sessionIdleMs = 30 min, requestTimeoutMs = 5 min }
 */
function createStreamableHttpHandler({ createServer, allowedOrigins = [], maxBodyBytes = MAX_MESSAGE, maxSessions = 1000, sessionIdleMs = 30 * 60_000, requestTimeoutMs = 5 * 60_000 } = {}) {
  if (typeof createServer !== 'function') throw new TypeError('createStreamableHttpHandler needs createServer()');
  const sessions = new Map();

  const reply = (res, status, body, headers = {}) => {
    if (res.headersSent) return;
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
    res.end(text);
  };
  const rpcError = (code, message, id = null) => ({ jsonrpc: '2.0', error: { code, message }, id });

  // Une session expire après sessionIdleMs sans requête, jamais pendant qu'une requête est en cours.
  function touch(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.inflight > 0) touch(entry);
      else closeSession(entry.id);
    }, sessionIdleMs);
    entry.timer.unref?.();
  }
  async function closeSession(id) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    clearTimeout(entry.timer);
    await entry.server.close().catch(() => {});
  }

  async function handler(req, res) {
    try {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.includes(origin)) return reply(res, 403, rpcError(ErrorCode.ConnectionClosed, 'Forbidden: origin not allowed'));
      const version = req.headers['mcp-protocol-version'];
      if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) return reply(res, 400, rpcError(ErrorCode.ConnectionClosed, `Bad Request: Unsupported protocol version: ${String(version).slice(0, 40)} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`));
      const sessionHeader = req.headers['mcp-session-id'];

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sessionHeader) return reply(res, 400, rpcError(ErrorCode.ConnectionClosed, 'Bad Request: Mcp-Session-Id header is required'));
        if (!sessions.has(sessionHeader)) return reply(res, 404, rpcError(-32001, 'Session not found'));
        // Pas de flux GET : le serveur n'envoie rien au client hors des réponses à ses requêtes.
        if (req.method === 'GET') return reply(res, 405, rpcError(ErrorCode.ConnectionClosed, 'Method not allowed.'), { allow: 'POST, DELETE' });
        await closeSession(sessionHeader);
        return reply(res, 200);
      }
      if (req.method !== 'POST') return reply(res, 405, rpcError(ErrorCode.ConnectionClosed, 'Method not allowed.'), { allow: 'POST, DELETE' });

      const accept = String(req.headers.accept || '');
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return reply(res, 406, rpcError(ErrorCode.ConnectionClosed, 'Not Acceptable: Client must accept both application/json and text/event-stream'));
      if (!String(req.headers['content-type'] || '').includes('application/json')) return reply(res, 415, rpcError(ErrorCode.ConnectionClosed, 'Unsupported Media Type: Content-Type must be application/json'));

      let text;
      try {
        text = await readBody(req, maxBodyBytes);
      } catch (error) {
        res.on('finish', () => req.destroy());
        return reply(res, error.status === 413 ? 413 : 400, rpcError(ErrorCode.ParseError, error.status === 413 ? 'Payload too large' : 'Parse error'), { connection: 'close' });
      }
      const parsed = parseJson(text);
      if (!parsed.ok) return reply(res, 400, rpcError(ErrorCode.ParseError, 'Parse error: Invalid JSON-RPC message'));
      const batch = Array.isArray(parsed.value);
      const messages = batch ? parsed.value : [parsed.value];
      if (!messages.length || messages.length > 100 || messages.some((m) => messageKind(m) === null)) return reply(res, 400, rpcError(ErrorCode.ParseError, 'Parse error: Invalid JSON-RPC message'));

      const initialize = messages.some((m) => m.method === 'initialize' && messageKind(m) === 'request');
      let entry;
      if (initialize) {
        if (messages.length > 1) return reply(res, 400, rpcError(ErrorCode.InvalidRequest, 'Invalid Request: Only one initialization request is allowed'));
        if (sessionHeader && sessions.has(sessionHeader)) return reply(res, 400, rpcError(ErrorCode.InvalidRequest, 'Invalid Request: Server already initialized'));
        if (sessions.size >= maxSessions) return reply(res, 503, rpcError(ErrorCode.ConnectionClosed, 'Too many sessions'));
        const transport = sessionTransport();
        transport.sessionId = crypto.randomUUID();
        const server = createServer();
        await server.connect(transport);
        entry = { id: transport.sessionId, server, transport, inflight: 0 };
        sessions.set(entry.id, entry);
      } else {
        if (!sessionHeader) return reply(res, 400, rpcError(ErrorCode.ConnectionClosed, 'Bad Request: Mcp-Session-Id header is required'));
        entry = sessions.get(sessionHeader);
        if (!entry) return reply(res, 404, rpcError(-32001, 'Session not found'));
      }
      touch(entry);

      const requests = messages.filter((m) => messageKind(m) === 'request');
      const answers = requests.map((m) => new Promise((resolve) => {
        if (entry.transport.waiting.has(m.id)) {
          resolve(rpcError(ErrorCode.InvalidRequest, 'Duplicate request id', m.id));
          return;
        }
        entry.transport.waiting.set(m.id, resolve);
      }));
      for (const message of messages) entry.transport.onmessage?.(message);
      if (!requests.length) return reply(res, 202);

      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), requestTimeoutMs);
        timer.unref?.();
      });
      entry.inflight += 1;
      const results = await Promise.race([Promise.all(answers), timeout]);
      entry.inflight -= 1;
      clearTimeout(timer);
      touch(entry);
      if (results === 'timeout') {
        for (const m of requests) entry.transport.waiting.delete(m.id);
        return reply(res, 504, rpcError(ErrorCode.RequestTimeout, 'Request timed out'));
      }
      const body = results.map((r, i) => r || rpcError(ErrorCode.ConnectionClosed, 'Connection closed', requests[i].id));
      return reply(res, 200, batch ? body : body[0], initialize ? { 'mcp-session-id': entry.id } : {});
    } catch {
      return reply(res, 500, rpcError(ErrorCode.InternalError, 'Internal server error'));
    }
  }

  handler.closeAll = async () => {
    for (const id of [...sessions.keys()]) await closeSession(id);
  };
  Object.defineProperty(handler, 'sessionCount', { get: () => sessions.size });
  return handler;
}

module.exports = { createInMemoryTransportPair, createStdioServerTransport, createStreamableHttpClientTransport, createStreamableHttpHandler, readServerSentEvents };
