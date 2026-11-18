/* global fetch, AbortController */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { assertVectors, assertFuzz, gen, assertSafeRegex, extractRegexLiterals } = require('@astratra/testkit/security');
const m = require('../src');

// MCP sans le SDK : réponses du serveur, du transport HTTP et messages du client comparés au SDK officiel enregistré,
// le SDK lui-même contre nos serveurs et notre client quand MCP_SDK_PROJECT est donné, puis essais d'attaque.

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sdk-reference.json'), 'utf8'));
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const listed = reference.server['tools/list'].replies[2][0].result.tools;

/** Le même serveur que celui du SDK enregistré : mêmes outils, mêmes schémas. */
function ourServer(extra = {}) {
  const server = m.createMcpServer({ name: 'essai', version: '1.0.0' }, { instructions: 'Instructions du serveur.', ...extra });
  const def = (name) => listed.find((t) => t.name === name);
  server.tool(def('addition'), async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
  server.tool(def('echo'), async ({ texte }) => ({ content: [{ type: 'text', text: texte }] }));
  server.tool(def('panne'), async () => {
    throw new Error('secret interne : /etc/chemin et clé');
  });
  server.tool(def('refus'), async () => ({ isError: true, content: [{ type: 'text', text: 'refusé' }] }));
  return server;
}

async function runServerScenario(messages) {
  const [client, serverSide] = m.createInMemoryTransportPair();
  const received = [];
  client.onmessage = (message) => received.push(message);
  await ourServer().connect(serverSide);
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

const noListChanged = (replies) => JSON.parse(JSON.stringify(replies, (k, v) => (k === 'tools' && v && v.listChanged !== undefined && !Array.isArray(v) ? {} : v)));

describe(`comparé à ${reference.source}`, () => {
  test(`mêmes réponses du serveur sur ${Object.keys(reference.server).length} scénarios, sauf les écarts voulus`, async () => {
    // Écarts voulus, chacun avec sa raison.
    const intended = {
      'initialize sans version': (r) => r.error?.code === -32602 && /protocolVersion/.test(r.error.message), // le SDK : -32603 et le vidage de son schéma
      'initialize sans paramètres': (r) => r.error?.code === -32602,
      'tools/call sans nom': (r) => r.error?.code === -32602 && /name is required/.test(r.error.message),
      'tools/list curseur inconnu': (r) => r.error?.code === -32602, // le SDK ignore le curseur ; la spécification demande -32602
      'tools/call outil qui lève': (r) => r.result?.isError === true && !JSON.stringify(r).includes('secret'), // le SDK renvoie le message de l'exception
    };
    // Le texte d'une erreur de validation vient de zod chez le SDK : seul le début est le même.
    const validation = ['tools/call argument manquant', 'tools/call mauvais type', 'tools/call sans arguments'];
    await assertVectors(Object.entries(reference.server).map(([id, c]) => ({ id, input: c, expected: true })), async (c, vector) => {
      const ours = noListChanged(await runServerScenario(c.messages));
      const theirs = noListChanged(c.replies);
      const last = ours[ours.length - 1][0];
      if (intended[vector.id]) return intended[vector.id](last) && JSON.stringify(sortKeys(ours.slice(0, -1))) === JSON.stringify(sortKeys(theirs.slice(0, -1))) ? true : ours;
      if (validation.includes(vector.id)) {
        const prefix = 'MCP error -32602: Input validation error: Invalid arguments for tool addition: ';
        return last.result?.isError === true && last.result.content[0].text.startsWith(prefix) && theirs[theirs.length - 1][0].result.content[0].text.startsWith(prefix) ? true : ours;
      }
      return JSON.stringify(sortKeys(ours)) === JSON.stringify(sortKeys(theirs)) ? true : { ours, theirs };
    });
  });

  test(`mêmes réponses HTTP sur ${Object.keys(reference.http).length} requêtes, sauf les écarts voulus`, async () => {
    const handler = m.createStreamableHttpHandler({ createServer: () => ourServer() });
    const server = http.createServer(handler);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const ACCEPT = 'application/json, text/event-stream';
    const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'enregistreur', version: '1' } } };
    const json = (message, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers }, body: typeof message === 'string' ? message : JSON.stringify(message) });
    const init = await fetch(url, json(INIT));
    const session = init.headers.get('mcp-session-id');
    await init.text();
    await fetch(url, json({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': session })).then((r) => r.text());
    const withSession = { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' };
    const ping = { jsonrpc: '2.0', id: 2, method: 'ping' };
    const cases = {
      'sans Accept': { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(INIT) },
      'Accept JSON seulement': json(INIT, { accept: 'application/json' }),
      'mauvais Content-Type': { method: 'POST', headers: { 'content-type': 'text/plain', accept: ACCEPT }, body: JSON.stringify(INIT) },
      'JSON invalide': json('{pas du json', withSession),
      'pas du JSON-RPC': json({ bonjour: 1 }, withSession),
      'initialize deux fois dans la session': json(INIT, withSession),
      'requête sans session': json(ping),
      'session inconnue': json(ping, { 'mcp-session-id': 'inconnue' }),
      'version de protocole inconnue': json(ping, { 'mcp-session-id': session, 'mcp-protocol-version': '1999-01-01' }),
      ping: json(ping, withSession),
      'tools/call': json({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'addition', arguments: { a: 2, b: 3 } } }, withSession),
      'notification seule': json({ jsonrpc: '2.0', method: 'notifications/inconnue' }, withSession),
      'lot avec initialize': json([INIT, ping]),
      'lot de deux requêtes': json([ping, { jsonrpc: '2.0', id: 7, method: 'tools/list' }], withSession),
      PUT: { method: 'PUT', headers: withSession },
      'GET sans session': { method: 'GET', headers: { accept: 'text/event-stream' } },
      'Origin d’une autre page': json(INIT, { origin: 'https://attaquant.example' }),
      'DELETE session inconnue': { method: 'DELETE', headers: { 'mcp-session-id': 'inconnue' } },
      DELETE: { method: 'DELETE', headers: withSession },
      'après DELETE': json(ping, withSession),
    };
    const intended = { 'Origin d’une autre page': { status: 403 } }; // le SDK ne vérifie pas Origin par défaut
    const results = {};
    for (const [name, init2] of Object.entries(cases)) {
      const response = await fetch(url, init2);
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      results[name] = { status: response.status, type: (response.headers.get('content-type') || '').split(';')[0], session: response.headers.get('mcp-session-id') ? 'présente' : null, body };
    }
    await handler.closeAll();
    server.close();
    // Le SDK renvoie l'en-tête de session sur chaque réponse d'une session ouverte ; ici seulement sur initialize.
    const comparable = (r) => sortKeys(noListChanged({ ...r, session: null }));
    await assertVectors(Object.entries(reference.http).map(([id, expected]) => ({ id, input: id, expected: intended[id] ? intended[id] : comparable(expected) })), (id) => (intended[id] ? { status: results[id].status } : comparable(results[id])));
  });

  test(`mêmes messages du client que Client du SDK (${reference.client.length}) : poignée de main, pages, appel, délai avec annulation, ping`, async () => {
    const [clientSide, serverSide] = m.createInMemoryTransportPair();
    const sent = [];
    serverSide.onmessage = async (message) => {
      sent.push(message);
      const reply = (result) => serverSide.send({ jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'initialize') await reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'faux', version: '1' } });
      else if (message.method === 'tools/list') await reply(message.params?.cursor ? { tools: [{ name: 'b', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'page2' });
      else if (message.method === 'ping') await reply({});
      else if (message.method === 'tools/call' && message.params.name === 'rapide') await reply({ content: [{ type: 'text', text: 'ok' }] });
    };
    const client = m.createMcpClient({ name: 'enregistreur', version: '1' });
    await client.connect(clientSide);
    await client.listTools();
    await client.listTools({ cursor: 'page2' });
    await client.callTool({ name: 'rapide', arguments: { x: 1 } });
    await expect(client.callTool({ name: 'lent', arguments: {} }, { timeoutMs: 50 })).rejects.toMatchObject({ code: -32001 });
    await tick();
    await client.ping();
    await client.close();
    expect(sent.map(sortKeys)).toEqual(reference.client.map(sortKeys));
  });
});

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}

/* Le SDK officiel contre nos serveurs et notre client : MCP_SDK_PROJECT=/chemin/vers/un/projet qui l'a installé. */
const sdkProject = process.env.MCP_SDK_PROJECT;
(sdkProject ? describe : describe.skip)('avec le SDK officiel', () => {
  const { createRequire } = require('node:module');
  const load = () => {
    const project = createRequire(path.join(sdkProject, 'package.json'));
    const sdk = (p) => project(`@modelcontextprotocol/sdk/${p}`);
    return { Client: sdk('client/index.js').Client, HttpClient: sdk('client/streamableHttp.js').StreamableHTTPClientTransport, StdioClient: sdk('client/stdio.js').StdioClientTransport, McpServer: sdk('server/mcp.js').McpServer, HttpServer: sdk('server/streamableHttp.js').StreamableHTTPServerTransport, Memory: sdk('inMemory.js').InMemoryTransport };
  };

  test('le client du SDK parle à notre serveur HTTP, en mémoire et en stdio', async () => {
    const s = load();
    const handler = m.createStreamableHttpHandler({ createServer: () => ourServer() });
    const server = http.createServer(handler);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const c1 = new s.Client({ name: 'sdk', version: '1' });
    const t1 = new s.HttpClient(new URL(`http://127.0.0.1:${server.address().port}/mcp`));
    await c1.connect(t1);
    expect((await c1.callTool({ name: 'addition', arguments: { a: 1, b: 2 } })).content[0].text).toBe('3');
    expect(c1.getInstructions()).toBe('Instructions du serveur.');
    await t1.terminateSession();
    await c1.close();
    expect(handler.sessionCount).toBe(0);
    server.close();
    const [a, b] = s.Memory.createLinkedPair();
    await ourServer().connect(b);
    const c2 = new s.Client({ name: 'sdk', version: '1' });
    await c2.connect(a);
    expect((await c2.listTools()).tools.map((t) => t.name)).toEqual(['addition', 'echo', 'panne', 'refus']);
    const script = path.join(require('node:os').tmpdir(), `mcp-stdio-${process.pid}.cjs`);
    fs.writeFileSync(script, `const m=require(${JSON.stringify(path.join(__dirname, '../src'))});m.createMcpServer({name:'stdio',version:'1'}).tool({name:'echo',description:'e',inputSchema:{type:'object',properties:{t:{type:'string'}},required:['t']}},async({t})=>t).connect(m.createStdioServerTransport());`);
    const c3 = new s.Client({ name: 'sdk', version: '1' });
    await c3.connect(new s.StdioClient({ command: process.execPath, args: [script] }));
    expect((await c3.callTool({ name: 'echo', arguments: { t: 'élève 🎉' } })).content[0].text).toBe('élève 🎉');
    await c3.close();
    fs.rmSync(script);
  }, 30_000);

  test('notre client parle au serveur HTTP du SDK, en JSON et en flux SSE', async () => {
    const s = load();
    const z = createRequire(path.join(sdkProject, 'package.json'))('zod');
    for (const enableJsonResponse of [true, false]) {
      const sessions = {};
      const app = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        let t = sessions[req.headers['mcp-session-id']];
        if (!t) {
          t = new s.HttpServer({ sessionIdGenerator: () => require('node:crypto').randomUUID(), enableJsonResponse, onsessioninitialized: (id) => { sessions[id] = t; } });
          const sdkServer = new s.McpServer({ name: 'eux', version: '1' });
          sdkServer.registerTool('addition', { description: 'a', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
          await sdkServer.connect(t);
        }
        await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      });
      await new Promise((ok) => app.listen(0, '127.0.0.1', ok));
      const client = m.createMcpClient();
      await client.connect(m.createStreamableHttpClientTransport(`http://127.0.0.1:${app.address().port}/mcp`));
      expect((await client.callTool({ name: 'addition', arguments: { a: 20, b: 22 } })).content[0].text).toBe('42');
      await client.close();
      app.closeAllConnections();
      app.close();
    }
  }, 30_000);
});

describe('attaques et limites', () => {
  let server;
  let base;
  let answer;
  beforeAll(async () => {
    server = http.createServer((req, res) => answer(req, res));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  });

  test('le transport client refuse les adresses et en-têtes piégés', () => {
    for (const url of ['http://exemple.test/mcp', 'https://user:pass@exemple.test/mcp', 'ftp://exemple.test', 'pas une adresse']) expect(() => m.createStreamableHttpClientTransport(url)).toThrow(TypeError);
    for (const headers of [{ 'Mcp-Session-Id': 'x' }, { accept: '*/*' }, { Authorization: 'Bearer a\r\nX-Evil: 1' }]) expect(() => m.createStreamableHttpClientTransport(`${base}/mcp`, { headers })).toThrow(TypeError);
    expect(() => m.createStreamableHttpClientTransport('https://exemple.test/mcp', { headers: { Authorization: 'Bearer clé' } })).not.toThrow();
  });

  test('un serveur distant hostile : redirection, réponse immense, flux immense, session invalide, JSON cassé', async () => {
    const connect = async () => {
      const client = m.createMcpClient(undefined, { timeoutMs: 2000 });
      await client.connect(m.createStreamableHttpClientTransport(`${base}/mcp`, { maxMessageBytes: 64 * 1024, maxStreamBytes: 256 * 1024 }));
      return client;
    };
    answer = (req, res) => res.writeHead(307, { location: 'http://169.254.169.254/' }).end();
    await expect(connect()).rejects.toMatchObject({ status: 307 });
    answer = (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(`{"jsonrpc":"2.0","id":0,"result":{"x":"${'a'.repeat(100_000)}"}}`);
    await expect(connect()).rejects.toThrow(/larger than/);
    answer = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const pump = () => {
        while (!res.destroyed && res.write(`data: {"jsonrpc":"2.0","method":"notifications/message","params":{"x":"${'b'.repeat(1000)}"}}\n\n`)) {
          // écrire tant que le client lit
        }
        if (!res.destroyed) res.once('drain', pump);
      };
      pump();
    };
    await expect(connect()).rejects.toThrow(/larger than/);
    answer = (req, res) => res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'a b' }).end('{}');
    await expect(connect()).rejects.toThrow(/Invalid session id/);
    answer = (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{pas du json');
    await expect(connect()).rejects.toThrow(/Invalid JSON/);
  }, 20_000);

  test('le serveur HTTP : Origin, taille du corps, lot trop grand, nombre et durée des sessions, délai d’une requête', async () => {
    const slow = () => m.createMcpServer({ name: 's', version: '1' }).tool({ name: 'lent', description: 'l', inputSchema: { type: 'object' } }, () => new Promise(() => {}));
    const handler = m.createStreamableHttpHandler({ createServer: slow, allowedOrigins: ['https://app.example'], maxBodyBytes: 10_000, maxSessions: 2, sessionIdleMs: 300, requestTimeoutMs: 600 });
    answer = handler;
    const post = (body, headers = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
    expect((await post(INIT, { origin: 'https://evil.example' })).status).toBe(403);
    const allowed = await post(INIT, { origin: 'https://app.example' });
    expect(allowed.status).toBe(200);
    const session = allowed.headers.get('mcp-session-id');
    expect((await post('x'.repeat(20_000))).status).toBe(413);
    expect((await post(Array.from({ length: 101 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })), { 'mcp-session-id': session })).status).toBe(400);
    expect((await post(INIT)).status).toBe(200);
    expect((await post(INIT)).status).toBe(503);
    const started = Date.now();
    const timedOut = await post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'lent', arguments: {} } }, { 'mcp-session-id': session });
    expect(timedOut.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(3000);
    // La session a survécu à la requête longue (elle n'expire pas pendant une requête), puis expire sans requête.
    expect((await post({ jsonrpc: '2.0', id: 4, method: 'ping' }, { 'mcp-session-id': session })).status).toBe(200);
    await new Promise((ok) => setTimeout(ok, 450));
    expect((await post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { 'mcp-session-id': session })).status).toBe(404);
    expect(handler.sessionCount).toBe(0);
  });

  test('un argument hors du schéma (additionalProperties: false) n’arrive jamais à l’outil', async () => {
    const server = m.createMcpServer({ name: 's', version: '1' }).tool({ name: 'vu', description: 'v', inputSchema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } }, async (args) => JSON.stringify(args));
    const [a, b] = m.createInMemoryTransportPair();
    await server.connect(b);
    const client = m.createMcpClient();
    await client.connect(a);
    expect((await client.callTool({ name: 'vu', arguments: { a: 'x', role: 'admin', __proto__: { admin: true } } })).content[0].text).toBe('{"a":"x"}');
    expect((await client.callTool({ name: 'vu', arguments: { a: 3 } })).isError).toBe(true);
  });

  test('une exception d’un traitement ne révèle jamais son message ; une McpError garde le sien', async () => {
    const server = m.createMcpServer({ name: 's', version: '1' }, { capabilities: { resources: {} } });
    server.setRequestHandler('resources/list', async (request) => {
      if (request.params?.cursor === 'mcp') throw new m.McpError(-32602, 'curseur refusé');
      throw new Error('SELECT * FROM secrets WHERE key = sk_live_123');
    });
    const [a, b] = m.createInMemoryTransportPair();
    await server.connect(b);
    const client = m.createMcpClient();
    await client.connect(a);
    const hidden = await client.request('resources/list').catch((e) => e);
    expect(hidden).toMatchObject({ code: -32603, rawMessage: 'Internal error' });
    expect(JSON.stringify(hidden)).not.toContain('sk_live');
    await expect(client.request('resources/list', { cursor: 'mcp' })).rejects.toMatchObject({ code: -32602, rawMessage: 'curseur refusé' });
  });

  test('annuler un appel : le traitement du serveur est prévenu, et aucune réponse n’arrive après', async () => {
    let aborted = false;
    const server = m.createMcpServer({ name: 's', version: '1' }).tool({ name: 'lent', description: 'l', inputSchema: { type: 'object' } }, (args, extra) => new Promise((resolve) => {
      extra.signal.addEventListener('abort', () => {
        aborted = true;
        resolve('trop tard');
      });
    }));
    const [a, b] = m.createInMemoryTransportPair();
    await server.connect(b);
    const seen = [];
    const client = m.createMcpClient();
    await client.connect(a);
    const original = a.onmessage;
    a.onmessage = (message) => {
      seen.push(message);
      original(message);
    };
    const controller = new AbortController();
    const call = client.callTool({ name: 'lent' }, { signal: controller.signal });
    await tick();
    controller.abort(new Error('l’utilisateur a annulé'));
    await expect(call).rejects.toThrow(/annulé/);
    await tick();
    expect(aborted).toBe(true);
    expect(seen.filter((msg) => msg.id !== undefined)).toEqual([]);
  });

  test('le fuzz : tout message brut donne une réponse bien formée ou rien, jamais un plantage ni deux réponses', async () => {
    const [a, b] = m.createInMemoryTransportPair();
    const errors = [];
    const server = ourServer();
    server.onerror = (error) => errors.push(error);
    await server.connect(b);
    const replies = [];
    a.onmessage = (message) => replies.push(message);
    await assertFuzz(async (message) => {
      replies.length = 0;
      await a.send(message);
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      const ids = replies.map((r) => r.id);
      if (new Set(ids).size !== ids.length) throw new Error('deux réponses pour la même requête');
      for (const r of replies) if (m.messageKind(r) !== 'response' && m.messageKind(r) !== 'error') throw new Error(`réponse mal formée : ${JSON.stringify(r)}`);
      return replies;
    }, { generator: gen.oneOf(gen.json(), gen.record({ jsonrpc: gen.elements(['2.0', '1.0', 2]), id: gen.oneOf(gen.integer(-5, 5), gen.hostileString(), gen.json()), method: gen.oneOf(gen.elements(['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/cancelled', '__proto__', 'constructor']), gen.hostileString()), params: gen.oneOf(gen.json(), gen.record({ name: gen.elements(['addition', 'echo', 'panne', 'inconnu', '__proto__']), arguments: gen.json(), cursor: gen.hostileString(), protocolVersion: gen.hostileString() })) })), runs: 600 });
  }, 60_000);

  test('stdio : lignes coupées, fins de ligne Windows, ligne trop longue refusée, JSON cassé signalé', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const errors = [];
    const transport = m.createStdioServerTransport({ stdin, stdout, maxMessageBytes: 1000 });
    const messages = [];
    transport.onmessage = (msg) => messages.push(msg);
    transport.onerror = (error) => errors.push(error.message);
    await transport.start();
    stdin.write('{"jsonrpc":"2.0",');
    stdin.write('"id":1,"method":"ping"}\r\n{"jsonrpc":"2.0","method":"x"}\n\n');
    stdin.write('{pas du json}\n');
    stdin.write('a'.repeat(2000));
    await tick();
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'x' }]);
    expect(errors).toEqual(['MCP error -32700: Parse error', 'MCP error -32600: message larger than 1000 bytes']);
    await transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    expect(stdout.read().toString()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await transport.close();
  });

  test('le client : un curseur qui se répète arrête la liste, un serveur à la mauvaise version est refusé', async () => {
    const fake = async (handlerFn) => {
      const [a, b] = m.createInMemoryTransportPair();
      b.onmessage = (msg) => {
        const result = handlerFn(msg);
        if (result !== undefined) b.send({ jsonrpc: '2.0', id: msg.id, result });
      };
      return a;
    };
    const looping = await fake((msg) => (msg.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } } : msg.method === 'tools/list' ? { tools: [], nextCursor: 'toujours' } : undefined));
    const client = m.createMcpClient();
    await client.connect(looping);
    await expect(client.listAllTools()).rejects.toThrow(/same cursor/);
    const old = await fake((msg) => (msg.method === 'initialize' ? { protocolVersion: '1999-01-01', capabilities: {}, serverInfo: { name: 'x', version: '1' } } : undefined));
    await expect(m.createMcpClient().connect(old)).rejects.toThrow(/not supported/);
  });

  test('aucune expression régulière du paquet ne s’emballe', async () => {
    for (const file of ['jsonrpc.js', 'server.js', 'client.js', 'transports.js']) {
      for (const regex of extractRegexLiterals(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'))) await assertSafeRegex(regex);
    }
  });
});
