#!/usr/bin/env node
/**
 * astratra-web-browser : le service navigateur du paquet @astratra/web-search.
 *
 *   astratra-web-browser serve [--port 5008] [--proxy-port 5009] [--token-file F] [--max-contexts 2]
 *                              [--queue-ms 10000] [--info-url U] [--signing-key-file F --signature-agent U]
 *                              [--unsafe-no-firewall]
 *   astratra-web-browser setup --out DOSSIER --node /usr/bin/node --token-file /etc/astratra/browser-token
 *                              [--user navigateur] [--clients-group astratra-browser] [--chromium CHEMIN]
 *                              [--browsers-path P] [--dns 127.0.0.53] [--port 5008] [--proxy-port 5009]
 *                              [--memory-max 2G] [--cpu-quota 200%]
 *     vérifie aussi la machine (Linux, systemd, nftables, AppArmor, Node, Chromium) et dit ce qui manque ;
 *     sans --dns, les résolveurs viennent de /etc/resolv.conf.
 *   astratra-web-browser token --out FICHIER [--group astratra-browser]
 *     avec --group : fichier en mode 640, lisible par ce groupe (les applications qui appellent le service).
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

/** Les résolveurs DNS de la machine (lignes nameserver de resolv.conf). */
function resolversOf(text) {
  return String(text || '').split('\n')
    .map((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1])
    .filter((address) => address && require('net').isIP(address.replace(/%.*$/, '')))
    .map((address) => address.replace(/%.*$/, ''));
}

/** Vrai si une commande se trouve dans le PATH ou dans /usr/sbin, /sbin. */
function hasCommand(name, env = process.env, exists = fs.existsSync) {
  const dirs = [...String(env.PATH || '').split(path.delimiter), '/usr/sbin', '/sbin', '/usr/bin', '/bin'].filter(Boolean);
  return dirs.some((dir) => exists(path.join(dir, name)));
}

/**
 * Ce que la machine a, et ce qui manque pour le service.
 * @param {object} [host]  ce qui est lu sur la machine (remplaçable dans les tests).
 * @returns {{ name: string, ok: boolean, detail: string, fix?: string }[]}
 */
function inspectBrowserHost(host = {}) {
  const platform = host.platform || process.platform;
  const exists = host.exists || fs.existsSync;
  const read = host.read || ((file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (_error) {
      return null;
    }
  });
  const command = host.hasCommand || ((name) => hasCommand(name, process.env, exists));
  const nodeVersion = host.nodeVersion || process.versions.node;
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, ...(ok || !fix ? {} : { fix }) });
  const linux = platform === 'linux';
  add('linux', linux, linux ? 'Linux' : platform,
    'The service, its firewall and its systemd unit need a Linux server. On macOS or Windows, use createLocalBrowser() for development.');
  if (!linux) return checks;
  add('systemd', exists('/run/systemd/system'), exists('/run/systemd/system') ? 'systemd is running' : 'no systemd',
    'Without systemd, use createBrowserPm2App (fewer protections) and keep the firewall.');
  add('nftables', command('nft'), command('nft') ? 'nft found' : 'nft not found', 'Install nftables (apt install nftables): the firewall is mandatory.');
  const restricted = String(read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') || '').trim() === '1';
  if (restricted) {
    add('apparmor', Boolean(host.chromiumPath), host.chromiumPath ? `profile written for ${host.chromiumPath}` : 'user namespaces are restricted and Chromium was not found',
      'Install Chromium first (PLAYWRIGHT_BROWSERS_PATH=… npx playwright install --with-deps chromium-headless-shell), then rerun setup with --browsers-path or --chromium.');
  } else {
    add('apparmor', true, 'user namespaces are not restricted (no AppArmor profile needed)');
  }
  const major = Number(String(nodeVersion).split('.')[0]);
  add('node', major >= 22, `Node ${nodeVersion}`, 'Install Node 22 or later.');
  add('chromium', Boolean(host.chromiumPath), host.chromiumPath || 'chrome-headless-shell not found',
    'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx playwright install --with-deps chromium-headless-shell, then --browsers-path /opt/ms-playwright.');
  const resolvers = host.resolvers || [];
  add('dns', resolvers.length > 0, resolvers.length ? `resolvers ${resolvers.join(', ')}` : 'no resolver in /etc/resolv.conf', 'Pass --dns with the address of the resolver the server uses.');
  return checks;
}

function setup(values) {
  const { browserSetupFiles } = require('./deploy');
  if (!values.out) throw new Error('--out <folder> is required.');
  if (!values['token-file']) throw new Error('--token-file <path> is required (the file the service and the applications read).');
  const browsersPath = values['browsers-path'] || process.env.PLAYWRIGHT_BROWSERS_PATH || undefined;
  const chromiumPath = values.chromium || headlessShellIn(browsersPath) || undefined;
  const given = values.dns ? String(values.dns).split(',').map((item) => item.trim()).filter(Boolean) : null;
  const detected = resolversOf(fs.existsSync('/etc/resolv.conf') ? fs.readFileSync('/etc/resolv.conf', 'utf8') : '');
  const dnsServers = given || (detected.length ? detected : undefined);
  const checks = inspectBrowserHost({ chromiumPath, resolvers: dnsServers || [] });
  process.stdout.write('Machine check:\n');
  for (const check of checks) process.stdout.write(`  ${check.ok ? 'ok     ' : 'MISSING'} ${check.name}: ${check.detail}${check.fix ? `\n          → ${check.fix}` : ''}\n`);
  const files = browserSetupFiles({
    node: values.node || process.execPath,
    user: values.user || 'navigateur',
    clientsGroup: values['clients-group'] || 'astratra-browser',
    tokenFile: values['token-file'],
    chromiumPath,
    browsersPath,
    dnsServers,
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
  const missing = checks.filter((check) => !check.ok).length;
  process.stdout.write(`Wrote ${Object.keys(files).join(', ')} to ${out}. Follow ${path.join(out, 'INSTALL.md')} (French: INSTALL.fr.md).\n`
    + (missing ? `${missing} item(s) above must be fixed before the service can start safely.\n` : ''));
  return { checks, files: Object.keys(files) };
}

/** L'identifiant d'un groupe, par son nom ou son numéro. */
function groupId(group) {
  if (/^\d+$/.test(String(group))) return Number(group);
  if (!/^[a-z_][a-z0-9_-]*$/.test(String(group))) throw new Error(`--group: invalid group name ${String(group).slice(0, 40)}.`);
  try {
    const line = require('child_process').execFileSync('getent', ['group', group], { encoding: 'utf8' });
    const gid = Number(line.split(':')[2]);
    if (Number.isInteger(gid)) return gid;
  } catch (_error) {
    /* pas de getent : /etc/group */
  }
  const entry = (fs.existsSync('/etc/group') ? fs.readFileSync('/etc/group', 'utf8') : '').split('\n').find((line) => line.split(':')[0] === group);
  const gid = entry ? Number(entry.split(':')[2]) : NaN;
  if (!Number.isInteger(gid)) throw new Error(`--group: no group named ${group} (create it with groupadd --system ${group}).`);
  return gid;
}

/**
 * Le jeton du service : 32 octets tirés au hasard, jamais écrasé. Avec
 * --group, le fichier est lisible par ce groupe (mode 640) : on y met les
 * utilisateurs des applications qui appellent le service ; les autres
 * programmes de la machine ne le lisent pas.
 */
function token(values) {
  if (!values.out) throw new Error('--out <file> is required.');
  const gid = values.group ? groupId(values.group) : null;
  const target = writeSecret(values.out, `${crypto.randomBytes(32).toString('base64url')}\n`);
  if (gid !== null) {
    try {
      fs.chownSync(target, -1, gid);
      fs.chmodSync(target, 0o640);
    } catch (error) {
      fs.rmSync(target, { force: true });
      throw new Error(`could not give the token to group ${values.group} (${error.code || 'error'}): run this command as root.`, { cause: error });
    }
  }
  process.stdout.write(`Token written to ${target} (mode ${gid === null ? '600' : `640, group ${values.group}`}).\n`);
  if (gid !== null && (fs.statSync(path.dirname(target)).mode & 0o011) === 0) {
    process.stdout.write(`Warning: ${path.dirname(target)} is not traversable by the group: the applications cannot reach the token (chmod 755 ${path.dirname(target)}).\n`);
  }
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
      directory: { type: 'string' },
      group: { type: 'string' },
      'clients-group': { type: 'string' }
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

module.exports = { main, headlessShellIn, inspectBrowserHost, resolversOf, setup, token };
