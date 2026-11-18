'use strict';

/*
 * Les mutations du paquet mcp : chaque cas casse une protection ou une règle du protocole, et ses essais doivent
 * échouer. Lancé à la main (npm run verify:mutations dans ce paquet).
 */
const path = require('node:path');
const { runMutations } = require('@astratra/testkit/security');

const cases = [
  ['src/transports.js', 'Origin non vérifié', "if (origin !== undefined && !allowedOrigins.includes(origin)) return reply(res, 403", 'if (false) return reply(res, 403'],
  ['src/transports.js', 'Accept non vérifié', "if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return reply(res, 406", 'if (false) return reply(res, 406'],
  ['src/transports.js', 'corps sans limite', "      if (size > limit) {\n        // La lecture s'arrête ici", "      if (false) {\n        // La lecture s'arrête ici"],
  ['src/transports.js', 'lot sans limite', 'messages.length > 100 ||', ''],
  ['src/transports.js', 'sessions sans limite', "if (sessions.size >= maxSessions) return reply(res, 503", 'if (false) return reply(res, 503'],
  ['src/transports.js', 'session fermée pendant une requête', '      if (entry.inflight > 0) touch(entry);\n      else closeSession(entry.id);', '      closeSession(entry.id);'],
  ['src/transports.js', 'requête sans délai', "        timer = setTimeout(() => resolve('timeout'), requestTimeoutMs);", "        timer = setTimeout(() => resolve('timeout'), 3_600_000);"],
  ['src/transports.js', 'http:// vers une autre machine', "if (parsed.protocol === 'http:' && !LOOPBACK.has(parsed.hostname)) throw", 'if (false) throw'],
  ['src/transports.js', 'en-tête géré remplaçable', "    if (MANAGED.has(name.toLowerCase())) throw", '    if (false) throw'],
  ['src/transports.js', 'redirection suivie', "body: JSON.stringify(message), redirect: 'manual',", "body: JSON.stringify(message), redirect: 'follow',"],
  ['src/transports.js', 'réponse lue sans limite', "      if (size > limit) throw new McpError(ErrorCode.InvalidRequest, `response larger than ${limit} bytes`);", ''],
  ['src/transports.js', 'flux lu sans limite', "      if (total > maxStreamBytes) throw new McpError(ErrorCode.InvalidRequest, `stream larger than ${maxStreamBytes} bytes`);", ''],
  ['src/transports.js', 'identifiant de session non vérifié', "if (!SESSION_ID.test(newSession)) throw new McpError(ErrorCode.InvalidRequest, 'Invalid session id from server');", ''],
  ['src/transports.js', 'ligne stdio sans limite', '    if (Buffer.byteLength(buffer) > maxMessageBytes) {', '    if (false) {'],
  ['src/jsonrpc.js', 'réponse après annulation', '    if (controller.signal.aborted) return;\n    await send(response).catch(fail);', '    await send(response).catch(fail);'],
  ['src/jsonrpc.js', 'message d’exception révélé', "message: known ? error.rawMessage : 'Internal error'", 'message: known ? error.rawMessage : error.message'],
  ['src/server.js', 'message d’exception d’outil révélé', "return { isError: true, content: [{ type: 'text', text: `Tool ${name} failed` }] };", "return { isError: true, content: [{ type: 'text', text: error.message }] };"],
  ['src/server.js', 'argument hors schéma transmis', "const args = schema.additionalProperties === false && isPlainObject(schema.properties) ?", 'const args = false ?'],
  ['src/server.js', 'type d’argument non vérifié', '    if (!ok) return `argument "${name}" must be ${types.join(\' or \')}`;', ''],
  ['src/server.js', 'initialize sans paramètres accepté', "if (!isPlainObject(params) || typeof params.protocolVersion !== 'string') throw", 'if (false) throw'],
  ['src/client.js', 'curseur répété accepté', "if (seen.has(cursor)) throw new McpError(ErrorCode.InvalidRequest, 'tools/list returned the same cursor twice');", ''],
  ['src/client.js', 'version du serveur non vérifiée', "if (!isPlainObject(result) || !SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) throw", 'if (!isPlainObject(result)) throw'],
].map(([file, name, before, after]) => ({ file, name, before, after }));

const report = runMutations({
  cwd: path.resolve(__dirname, '..'),
  cases,
  command: ['npx', ['jest', '__tests__/mcp.test.js', '--testTimeout=30000']],
  onResult: (r) => process.stdout.write(`${r.killed ? 'tuée    ' : 'SURVIT  '} ${r.name}\n`),
});
if (!report.allKilled) {
  process.stderr.write(`${report.survivors.length} mutation(s) ont survécu.\n`);
  process.exit(1);
}
process.stdout.write(`${report.results.length} mutations, toutes tuées.\n`);
