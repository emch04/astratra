/* global AbortController */
/*
 * Le cœur JSON-RPC 2.0 de MCP : vérifier un message, relier chaque réponse à sa requête, abandonner une requête trop
 * longue (avec notifications/cancelled, comme le SDK), annuler un traitement quand l'autre côté le demande.
 *
 * Un transport a la forme de ceux du SDK officiel : start(), send(message), close(), et les rappels onmessage,
 * onclose, onerror posés par la session. Un transport du SDK se branche donc tel quel.
 */

const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';

const ErrorCode = Object.freeze({
  ConnectionClosed: -32000,
  RequestTimeout: -32001,
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
});

class McpError extends Error {
  constructor(code, message, data) {
    super(`MCP error ${code}: ${message}`);
    this.name = 'McpError';
    this.code = code;
    this.rawMessage = message;
    if (data !== undefined) this.data = data;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (id) => (typeof id === 'string' && id.length <= 256) || (Number.isSafeInteger(id));

/** La sorte d'un message JSON-RPC 2.0, ou null s'il n'en est pas un. */
function messageKind(message) {
  if (!isPlainObject(message) || message.jsonrpc !== '2.0') return null;
  const hasMethod = typeof message.method === 'string' && message.method.length > 0 && message.method.length <= 256;
  if (message.params !== undefined && !isPlainObject(message.params)) return null;
  if (hasMethod && 'id' in message) return isId(message.id) ? 'request' : null;
  if (hasMethod) return 'notification';
  if (!('id' in message) || !isId(message.id)) return null;
  if ('result' in message && !('error' in message)) return isPlainObject(message.result) ? 'response' : null;
  if ('error' in message && !('result' in message)) return isPlainObject(message.error) && Number.isInteger(message.error.code) && typeof message.error.message === 'string' ? 'error' : null;
  return null;
}

/**
 * Une session JSON-RPC sur un transport.
 * @param {object} options
 * @param {(request, extra) => Promise<object>} options.onRequest  rend le résultat, ou lève (McpError pour un code)
 * @param {(notification) => void} [options.onNotification]
 * @param {(error) => void} [options.onError]
 * @param {() => void} [options.onClose]
 */
function createSession({ onRequest, onNotification = () => {}, onError = () => {}, onClose = () => {} }) {
  let transport = null;
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const running = new Map();

  const fail = (error) => {
    try {
      onError(error);
    } catch {
      // un rappel d'erreur qui lève ne doit pas arrêter la session
    }
  };

  async function send(message) {
    if (!transport || closed) throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
    await transport.send(message);
  }

  function settle(id, fn) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    fn(entry);
  }

  async function handleRequest(message) {
    const controller = new AbortController();
    running.set(message.id, controller);
    let response;
    try {
      const result = await onRequest(message, {
        signal: controller.signal,
        requestId: message.id,
        sessionId: transport?.sessionId,
        sendNotification: (notification) => (controller.signal.aborted ? Promise.resolve() : send({ jsonrpc: '2.0', ...notification })),
      });
      response = { jsonrpc: '2.0', id: message.id, result: isPlainObject(result) ? result : {} };
    } catch (error) {
      const known = error instanceof McpError;
      response = { jsonrpc: '2.0', id: message.id, error: { code: known ? error.code : ErrorCode.InternalError, message: known ? error.rawMessage : 'Internal error', ...(known && error.data !== undefined ? { data: error.data } : {}) } };
    } finally {
      running.delete(message.id);
    }
    // Une requête annulée ne reçoit pas de réponse (spécification MCP, « Cancellation »).
    if (controller.signal.aborted) return;
    await send(response).catch(fail);
  }

  function receive(message) {
    const kind = messageKind(message);
    if (kind === 'request') {
      handleRequest(message).catch(fail);
    } else if (kind === 'notification') {
      if (message.method === 'notifications/cancelled') {
        const id = message.params?.requestId;
        running.get(id)?.abort(message.params?.reason);
        return;
      }
      try {
        onNotification(message);
      } catch (error) {
        fail(error);
      }
    } else if (kind === 'response') {
      settle(message.id, (entry) => entry.resolve(message.result));
    } else if (kind === 'error') {
      settle(message.id, (entry) => entry.reject(new McpError(message.error.code, String(message.error.message).slice(0, 1000), message.error.data)));
    } else {
      fail(new McpError(ErrorCode.InvalidRequest, 'Invalid JSON-RPC message'));
    }
  }

  function shutdown() {
    if (closed) return;
    closed = true;
    for (const id of [...pending.keys()]) settle(id, (entry) => entry.reject(new McpError(ErrorCode.ConnectionClosed, 'Connection closed')));
    for (const controller of running.values()) controller.abort();
    running.clear();
    try {
      onClose();
    } catch (error) {
      fail(error);
    }
  }

  return {
    async connect(t) {
      if (transport) throw new Error('already connected');
      transport = t;
      t.onmessage = (message) => receive(message);
      t.onerror = (error) => fail(error);
      t.onclose = () => shutdown();
      await t.start();
    },

    /** Envoie une requête et attend sa réponse (abandon après timeoutMs, ou sur signal, avec notifications/cancelled). */
    request(method, params, { timeoutMs = 60_000, signal } = {}) {
      if (closed || !transport) return Promise.reject(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'));
      if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new McpError(ErrorCode.RequestTimeout, 'Request aborted'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const cancel = (reason, error) => {
          settle(id, () => reject(error));
          send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } }).catch(() => {});
        };
        const entry = { resolve, reject, signal };
        entry.timer = setTimeout(() => {
          const error = new McpError(ErrorCode.RequestTimeout, 'Request timed out', { timeout: timeoutMs });
          cancel(String(error), error);
        }, timeoutMs);
        entry.timer.unref?.();
        if (signal) {
          entry.onAbort = () => cancel(String(signal.reason?.message || signal.reason || 'aborted'), signal.reason instanceof Error ? signal.reason : new McpError(ErrorCode.RequestTimeout, 'Request aborted'));
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        pending.set(id, entry);
        send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }).catch((error) => settle(id, () => reject(error)));
      });
    },

    notify(method, params) {
      return send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },

    async close() {
      const t = transport;
      shutdown();
      if (t) await t.close();
    },

    get transport() {
      return transport;
    },
  };
}

module.exports = { createSession, messageKind, McpError, ErrorCode, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_NEGOTIATED_PROTOCOL_VERSION };
