# @astratra/mcp

Le Model Context Protocol (MCP) sans dépendance : un **client** pour brancher une IA sur un serveur MCP, un
**serveur** pour offrir des outils à une IA, et les transports **stdio** et **Streamable HTTP**. Il remplace le SDK
officiel (`@modelcontextprotocol/sdk`, qui installe zod, express et une vingtaine d'autres paquets) pour ces usages,
et parle avec lui dans les deux sens.

## Un serveur d'outils

```js
const { createMcpServer, createStdioServerTransport } = require('@astratra/mcp');

const server = createMcpServer({ name: 'mes-outils', version: '1.0.0' }, { instructions: 'Outils de la boutique.' })
  .tool({
    name: 'stock',
    description: 'Le stock d’un produit',
    inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  }, async ({ sku }, { signal }) => JSON.stringify(await lireStock(sku, { signal })));

await server.connect(createStdioServerTransport());   // un éditeur ou un assistant lance ce fichier
```

Le texte rendu devient un résultat `{ content: [{ type: 'text', text }] }` ; un objet est rendu tel quel. Les
arguments sont vérifiés contre le schéma avant l'appel (objet, `required`, type et `enum` des propriétés) ; un
argument hors du schéma est retiré quand `additionalProperties` vaut `false`. Une exception de l'outil revient en
résultat `isError` avec un message générique : jamais le message de l'exception, qui peut contenir un chemin ou une
clé.

Pour une autre méthode : `server.setRequestHandler('resources/list', async (request, extra) => ({ … }))`. Une
`McpError(code, message)` garde son code et son message ; toute autre exception devient « Internal error ».

## En HTTP

```js
const http = require('node:http');
const { createStreamableHttpHandler } = require('@astratra/mcp');

const handler = createStreamableHttpHandler({
  createServer: () => creerMonServeur(),          // un serveur neuf par session
  allowedOrigins: ['https://app.exemple.fr'],     // pages web permises (aucune par défaut)
});
http.createServer(handler).listen(3001);          // ou app.post('/mcp', handler) avec Express
```

- **L'en-tête Origin est vérifié** : une page web ne peut pas parler au serveur sans être dans `allowedOrigins`
  (protection contre le « DNS rebinding », exigée par la spécification ; le SDK ne la fait pas par défaut).
- Le corps fait 4 Mio au plus, un lot 100 messages au plus ; 1 000 sessions au plus, fermées après 30 minutes sans
  requête (jamais pendant une requête) ; une requête plus longue que 5 minutes répond 504.
- Le serveur répond en JSON ; il n'ouvre pas de flux GET (rien n'est poussé au client hors des réponses).

## Un client

```js
const { createMcpClient, createStreamableHttpClientTransport } = require('@astratra/mcp');

const client = createMcpClient({ name: 'mon-app', version: '1.0.0' });
await client.connect(createStreamableHttpClientTransport('https://mcp.exemple.fr/mcp', { headers: { Authorization: `Bearer ${cle}` } }));

const outils = await client.listAllTools();
const resultat = await client.callTool({ name: 'stock', arguments: { sku: 'A12' } }, { timeoutMs: 20_000, signal });
await client.close();                              // ferme aussi la session chez le serveur
```

- L'adresse doit être en https:// (http:// seulement vers la machine), sans identifiants (la clé va dans les
  en-têtes) ; aucune redirection n'est suivie.
- Une réponse fait 4 Mio au plus, un flux SSE 16 Mio au plus ; un flux qui casse fait échouer sa requête tout de
  suite.
- Un appel trop long est abandonné et le serveur est prévenu (`notifications/cancelled`) ; un `signal` annule de la
  même façon.
- `listAllTools` s'arrête si un serveur renvoie deux fois le même curseur.

Le client répond lui-même aux requêtes `ping` du serveur et refuse les autres (ni sampling, ni elicitation, ni
roots).

## Avec le SDK officiel

Les transports ont la même forme que ceux du SDK (`start`, `send`, `close`, `onmessage`…) : un transport du SDK se
branche sur ce client ou ce serveur, et le client du SDK parle à ce serveur (HTTP, stdio, mémoire). Les essais le
vérifient avec `MCP_SDK_PROJECT=/chemin/vers/un/projet` qui a installé le SDK.

## Tests

```bash
npm test --workspace @astratra/mcp
npm run verify:mutations --workspace @astratra/mcp   # 22 mutations
```

Les réponses du serveur, du transport HTTP et les messages du client sont comparés au SDK 1.32.2, enregistré une
fois (`scripts/record-sdk-reference.cjs`).
