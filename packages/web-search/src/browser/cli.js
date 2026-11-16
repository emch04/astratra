#!/usr/bin/env node
/**
 * astratra-web-browser : le service navigateur du paquet @astratra/web-search.
 *
 *   astratra-web-browser serve [--port 5008] [--proxy-port 5009] [--token-file F] [--max-contexts 2]
 *                              [--queue-ms 10000] [--info-url U] [--signing-key-file F --signature-agent U]
 *                              [--unsafe-no-firewall]
 *   astratra-web-browser setup --out DOSSIER --node /usr/bin/node --token-file /etc/astratra/browser-token
 *                              [--user navigateur] [--chromium CHEMIN] [--browsers-path P] [--dns 127.0.0.53]
 *                              [--port 5008] [--proxy-port 5009] [--memory-max 2G] [--cpu-quota 200%]
 *   astratra-web-browser token --out FICHIER
 *   astratra-web-browser keygen --out CLE.pem [--directory annuaire.json]
 *
 * Chaque option de `serve` se lit aussi dans l'environnement (WEB_BROWSER_PORT,
 * WEB_BROWSER_PROXY_PORT, WEB_BROWSER_TOKEN_FILE, WEB_BROWSER_MAX_CONTEXTS,
 * WEB_BROWSER_QUEUE_MS, WEB_BROWSER_INFO_URL, WEB_BROWSER_SIGNING_KEY_FILE,
 * WEB_BROWSER_SIGNATURE_AGENT).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs } = require('util');

const USAGE = `astratra-web-browser serve | setup | token | keygen  (voir le README de @astratra/web-search)`;

function integer(value, name, min, max) {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name}: ${min} to ${max}.`);
  return number;
}

function writeSecret(file, content) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  /* wx : ne jamais écraser un secret existant. */
  fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
  return target;
}

async function serve(values) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('refusing to run as root: start the service as its own system user (see astratra-web-browser setup).');
  }
  const env = process.env;
  const unsafeNoFirewall = values['unsafe-no-firewall'] === true;
  if (env.WEB_BROWSER_UNSAFE_NO_FIREWALL) throw new Error('--unsafe-no-firewall is a command-line flag only, never an environment variable.');
  const tokenFile = values['token-file'] || env.WEB_BROWSER_TOKEN_FILE;
  if (!tokenFile) throw new Error('a token file is required (--token-file or WEB_BROWSER_TOKEN_FILE).');
  const { createBrowserEngine } = require('./engine');
  const { createBrowserService } = require('./service');
  const { signerFromFile } = require('./webBotAuth');
  const signer = signerFromFile({
    signingKeyFile: values['signing-key-file'] || env.WEB_BROWSER_SIGNING_KEY_FILE,
    signatureAgent: values['signature-agent'] || env.WEB_BROWSER_SIGNATURE_AGENT
  });
  const engine = createBrowserEngine({
    infoUrl: values['info-url'] || env.WEB_BROWSER_INFO_URL || undefined,
    signer,
    proxyPort: integer(values['proxy-port'] || env.WEB_BROWSER_PROXY_PORT, 'proxy port', 1, 65535) ?? 5009,
    maxContexts: integer(values['max-contexts'] || env.WEB_BROWSER_MAX_CONTEXTS, 'max contexts', 1, 16),
    queueMs: integer(values['queue-ms'] || env.WEB_BROWSER_QUEUE_MS, 'queue ms', 0, 120_000)
  });
  const service = createBrowserService({
    engine,
    tokenFile,
    port: integer(values.port || env.WEB_BROWSER_PORT, 'port', 1, 65535) ?? 5008,
    unsafeNoFirewall,
    log: (event) => {
      if (event.outcome !== 'ok') process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    }
  });
  let started;
  try {
    started = await service.start();
  } catch (error) {
    if (error.code === 'isolation_failed') {
      process.stderr.write(`isolation_failed: ${JSON.stringify(error.isolation.probes)}\n`);
      process.stderr.write('The browser can reach the internal network. Load the firewall rules (astratra-web-browser setup), or use --unsafe-no-firewall on a development machine only.\n');
    }
    throw error;
  }
  const health = await engine.health();
  process.stdout.write(`astratra-web-browser ${health.version} listening on ${started.host}:${started.port}, Chromium ${health.chromium}, sandbox on, `
    + `${started.isolation.ok ? 'isolation ok' : 'ISOLATION FAILED (--unsafe-no-firewall: development only)'}\n`);
  const stop = async () => {
    await service.close().catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

function headlessShellIn(browsersPath) {
  if (!browsersPath || !fs.existsSync(browsersPath)) return null;
  for (const entry of fs.readdirSync(browsersPath).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse()) {
    const base = path.join(browsersPath, entry);
    for (const sub of fs.readdirSync(base)) {
      const candidate = path.join(base, sub, 'chrome-headless-shell');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function setup(values) {
  const { browserSetupFiles } = require('./deploy');
  if (!values.out) throw new Error('--out <folder> is required.');
  const browsersPath = values['browsers-path'] || process.env.PLAYWRIGHT_BROWSERS_PATH || undefined;
  const chromiumPath = values.chromium || headlessShellIn(browsersPath) || undefined;
  const files = browserSetupFiles({
    node: values.node || process.execPath,
    user: values.user || 'navigateur',
    tokenFile: values['token-file'],
    chromiumPath,
    browsersPath,
    dnsServers: values.dns ? String(values.dns).split(',').map((item) => item.trim()).filter(Boolean) : undefined,
    port: integer(values.port, 'port', 1, 65535),
    proxyPort: integer(values['proxy-port'], 'proxy port', 1, 65535),
    memoryMax: values['memory-max'],
    cpuQuota: values['cpu-quota'],
    infoUrl: values['info-url'],
    ...(values['signing-key-file'] ? { signingKeyFile: values['signing-key-file'], signatureAgent: values['signature-agent'] } : {})
  });
  const out = path.resolve(values.out);
  fs.mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(out, name), content, { mode: 0o644 });
  process.stdout.write(`Wrote ${Object.keys(files).join(', ')} to ${out}. Follow ${path.join(out, 'INSTALL.md')}.\n`);
}

function token(values) {
  if (!values.out) throw new Error('--out <file> is required.');
  const target = writeSecret(values.out, `${crypto.randomBytes(32).toString('base64url')}\n`);
  process.stdout.write(`Token written to ${target} (mode 600).\n`);
}

function keygen(values) {
  const { createSigningKey, signatureDirectory, jwkThumbprint, SIGNATURE_DIRECTORY_PATH, SIGNATURE_DIRECTORY_TYPE } = require('./webBotAuth');
  if (!values.out) throw new Error('--out <key.pem> is required.');
  const { privateKeyPem, publicJwk } = createSigningKey();
  const target = writeSecret(values.out, privateKeyPem);
  const directory = `${JSON.stringify(signatureDirectory(publicJwk), null, 2)}\n`;
  if (values.directory) fs.writeFileSync(path.resolve(values.directory), directory, { mode: 0o644 });
  process.stdout.write(`Private key written to ${target} (mode 600), keyid ${jwkThumbprint(publicJwk)}.\n`
    + `Publish this directory at https://<your domain>${SIGNATURE_DIRECTORY_PATH} with content-type ${SIGNATURE_DIRECTORY_TYPE}:\n${directory}`);
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      port: { type: 'string' },
      'proxy-port': { type: 'string' },
      'token-file': { type: 'string' },
      'max-contexts': { type: 'string' },
      'queue-ms': { type: 'string' },
      'info-url': { type: 'string' },
      'signing-key-file': { type: 'string' },
      'signature-agent': { type: 'string' },
      'unsafe-no-firewall': { type: 'boolean' },
      out: { type: 'string' },
      node: { type: 'string' },
      user: { type: 'string' },
      chromium: { type: 'string' },
      'browsers-path': { type: 'string' },
      dns: { type: 'string' },
      'memory-max': { type: 'string' },
      'cpu-quota': { type: 'string' },
      directory: { type: 'string' }
    }
  });
  if (command === 'serve' || command === undefined) return serve(values);
  if (command === 'setup') return setup(values);
  if (command === 'token') return token(values);
  if (command === 'keygen') return keygen(values);
  throw new Error(USAGE);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`astratra-web-browser: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { main, headlessShellIn };
