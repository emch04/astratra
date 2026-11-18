/* global fetch, AbortController */
'use strict';

/*
 * Enregistre, une fois, ce que fait le SDK MCP officiel (@modelcontextprotocol/sdk) pour comparer le paquet mcp
 * (__tests__/fixtures/sdk-reference.json) : les réponses de son serveur à un corpus de messages, les réponses HTTP de
 * son transport Streamable HTTP, et les messages qu'envoie son client. Le SDK n'est pas une dépendance d'Astratra :
 * le dossier d'un projet qui l'a installé est donné en argument.
 *   node scripts/record-sdk-reference.cjs /chemin/vers/un/projet
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const project = createRequire(path.join(path.resolve(process.argv[2]), 'package.json'));
// Le dossier du paquet (celui dont package.json porte le nom du SDK ; « exports » renvoie vers dist/cjs).
let sdkDir = path.dirname(project.resolve('@modelcontextprotocol/sdk/package.json'));
const nameAt = (dir) => (fs.existsSync(path.join(dir, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name : undefined);
while (nameAt(sdkDir) !== '@modelcontextprotocol/sdk') sdkDir = path.dirname(sdkDir);
const sdk = (p) => project(`@modelcontextprotocol/sdk/${p}`);
const { McpServer } = sdk('server/mcp.js');
const { Client } = sdk('client/index.js');
const { StreamableHTTPServerTransport } = sdk('server/streamableHttp.js');
const { InMemoryTransport } = sdk('inMemory.js');
const z = createRequire(path.join(sdkDir, 'package.json'))('zod');

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

function sdkServer() {
  const server = new McpServer({ name: 'essai', version: '1.0.0' }, { instructions: 'Instructions du serveur.' });
  server.registerTool('addition', { description: 'Additionne deux nombres', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
  server.registerTool('echo', { description: 'Rend le texte', inputSchema: { texte: z.string() } }, async ({ texte }) => ({ content: [{ type: 'text', text: texte }] }));
  server.registerTool('panne', { description: 'Lève une erreur', inputSchema: {} }, async () => {
    throw new Error('secret interne : /etc/chemin et clé');
  });
  server.registerTool('refus', { description: 'Rend une erreur d’outil', inputSchema: {} }, async () => ({ isError: true, content: [{ type: 'text', text: 'refusé' }] }));
  return server;
}

// A. Le serveur : un corpus de messages, après la poignée de main ou avant.
const INIT = (protocolVersion, extra = {}) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'enregistreur', version: '1' }, ...extra } });
const SCENARIOS = {
  'initialize, dernière version': [INIT('2025-11-25')],
  'initialize, 2025-06-18': [INIT('2025-06-18')],
  'initialize, 2024-11-05': [INIT('2024-11-05')],
  'initialize, version inconnue': [INIT('2099-01-01')],
  'initialize sans version': [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'x', version: '1' } } }],
  'initialize sans paramètres': [{ jsonrpc: '2.0', id: 1, method: 'initialize' }],
};
const AFTER = {
  ping: { jsonrpc: '2.0', id: 2, method: 'ping' },
  'ping avec paramètres': { jsonrpc: '2.0', id: 'deux', method: 'ping', params: {} },
  'tools/list': { jsonrpc: '2.0', id: 3, method: 'tools/list' },
  'tools/list curseur inconnu': { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: 'zzz' } },
  'tools/call addition': { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'addition', arguments: { a: 2, b: 3 } } },
  'tools/call argument manquant': { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'addition', arguments: { a: 2 } } },
  'tools/call mauvais type': { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'addition', arguments: { a: 'deux', b: 3 } } },
  'tools/call sans arguments': { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'addition' } },
  'tools/call argument en trop': { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { texte: 'a', autre: 1 } } },
  'tools/call outil inconnu': { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'inconnu', arguments: {} } },
  'tools/call sans nom': { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { arguments: {} } },
  'tools/call outil qui lève': { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'panne', arguments: {} } },
  'tools/call erreur d’outil': { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'refus', arguments: {} } },
  'méthode inconnue': { jsonrpc: '2.0', id: 5, method: 'inconnue/methode' },
  'resources/list non servi': { jsonrpc: '2.0', id: 5, method: 'resources/list' },
  'notification inconnue': { jsonrpc: '2.0', method: 'notifications/inconnue' },
  'réponse sans requête': { jsonrpc: '2.0', id: 99, result: {} },
};
for (const [name, message] of Object.entries(AFTER)) SCENARIOS[name] = [INIT('2025-11-25'), { jsonrpc: '2.0', method: 'notifications/initialized' }, message];
SCENARIOS['tools/call avant initialize'] = [AFTER['tools/call addition']];
SCENARIOS['ping avant initialize'] = [AFTER.ping];

async function runServerScenario(messages) {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const received = [];
  client.onmessage = (message) => received.push(message);
  await client.start();
  await sdkServer().connect(server);
  const replies = [];
  for (const message of messages) {
    const before = received.length;
    await client.send(message);
    await tick();
    replies.push(received.slice(before));
  }
  await client.close();
  return replies;
}

// B. Le transport Streamable HTTP du serveur.
async function httpScenarios() {
  const sessions = {};
  let last = null;
  const app = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      parsed = undefined;
    }
    // Une seule session du SDK : une requête sans session ou avec une session inconnue va au transport existant, qui
    // la refuse lui-même ; seul un initialize sans session en crée un neuf.
    const sid = req.headers['mcp-session-id'];
    const isInit = !sid && (Array.isArray(parsed) ? parsed : [parsed]).some((m) => m && m.method === 'initialize');
    let transport = sid ? sessions[sid] || last : isInit ? null : last;
    if (!transport) {
      const created = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true, onsessioninitialized: (id) => { sessions[id] = created; } });
      await sdkServer().connect(created);
      transport = created;
      if (!last) last = created;
    }
    await transport.handleRequest(req, res, parsed ?? body);
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}/mcp`;
  const ACCEPT = 'application/json, text/event-stream';
  const send = async (init) => {
    const controller = new AbortController();
    const response = await fetch(url, { ...init, signal: controller.signal });
    const type = response.headers.get('content-type') || '';
    let body;
    if (type.includes('text/event-stream')) {
      controller.abort();
      body = '(flux)';
    } else {
      const text = await response.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
    }
    return { status: response.status, type: type.split(';')[0], session: response.headers.get('mcp-session-id') ? 'présente' : null, body };
  };
  const json = (message, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers }, body: typeof message === 'string' ? message : JSON.stringify(message) });
  const init = await fetch(url, json(INIT('2025-11-25')));
  const session = init.headers.get('mcp-session-id');
  await init.text();
  await fetch(url, json({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': session })).then((r) => r.text());
  const withSession = { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' };
  const out = {};
  const cases = {
    'sans Accept': () => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(INIT('2025-11-25')) }),
    'Accept JSON seulement': () => json(INIT('2025-11-25'), { accept: 'application/json' }),
    'mauvais Content-Type': () => ({ method: 'POST', headers: { 'content-type': 'text/plain', accept: ACCEPT }, body: JSON.stringify(INIT('2025-11-25')) }),
    'JSON invalide': () => json('{pas du json', withSession),
    'pas du JSON-RPC': () => json({ bonjour: 1 }, withSession),
    'initialize deux fois dans la session': () => json(INIT('2025-11-25'), withSession),
    'requête sans session': () => json(AFTER.ping),
    'session inconnue': () => json(AFTER.ping, { 'mcp-session-id': 'inconnue' }),
    'version de protocole inconnue': () => json(AFTER.ping, { 'mcp-session-id': session, 'mcp-protocol-version': '1999-01-01' }),
    'ping': () => json(AFTER.ping, withSession),
    'tools/call': () => json(AFTER['tools/call addition'], withSession),
    'notification seule': () => json({ jsonrpc: '2.0', method: 'notifications/inconnue' }, withSession),
    'lot avec initialize': () => json([INIT('2025-11-25'), AFTER.ping]),
    'lot de deux requêtes': () => json([AFTER.ping, { ...AFTER['tools/list'], id: 7 }], withSession),
    'PUT': () => ({ method: 'PUT', headers: withSession }),
    'GET sans session': () => ({ method: 'GET', headers: { accept: 'text/event-stream' } }),
    'Origin d’une autre page': () => json(INIT('2025-11-25'), { origin: 'https://attaquant.example' }),
    'DELETE session inconnue': () => ({ method: 'DELETE', headers: { 'mcp-session-id': 'inconnue' } }),
    'DELETE': () => ({ method: 'DELETE', headers: withSession }),
    'après DELETE': () => json(AFTER.ping, withSession),
  };
  for (const [name, build] of Object.entries(cases)) out[name] = await send(build());
  app.closeAllConnections();
  app.close();
  return out;
}

// C. Les messages qu'envoie le client.
async function clientScenario() {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const sent = [];
  server.onmessage = async (message) => {
    sent.push(message);
    const reply = (result) => server.send({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') await reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'faux', version: '1' } });
    else if (message.method === 'tools/list') await reply(message.params?.cursor ? { tools: [{ name: 'b', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'page2' });
    else if (message.method === 'ping') await reply({});
    else if (message.method === 'tools/call' && message.params.name === 'rapide') await reply({ content: [{ type: 'text', text: 'ok' }] });
  };
  await server.start();
  const c = new Client({ name: 'enregistreur', version: '1' });
  await c.connect(client);
  await c.listTools();
  await c.listTools({ cursor: 'page2' });
  await c.callTool({ name: 'rapide', arguments: { x: 1 } });
  await c.callTool({ name: 'lent', arguments: {} }, undefined, { timeout: 50 }).catch(() => {});
  await tick();
  await c.ping();
  await c.close();
  return sent;
}

(async () => {
  const out = { source: `@modelcontextprotocol/sdk ${JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8')).version}`, server: {}, http: await httpScenarios(), client: await clientScenario() };
  for (const [name, messages] of Object.entries(SCENARIOS)) out.server[name] = { messages, replies: await runServerScenario(messages) };
  fs.mkdirSync(path.join(__dirname, '../__tests__/fixtures'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../__tests__/fixtures/sdk-reference.json'), `${JSON.stringify(out, null, 1)}\n`);
  process.stdout.write(`${Object.keys(out.server).length} scénarios serveur, ${Object.keys(out.http).length} requêtes HTTP, ${out.client.length} messages du client (${out.source}).\n`);
  process.exit(0);
})();
