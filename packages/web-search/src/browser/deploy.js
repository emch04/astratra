/**
 * Les fichiers de déploiement du service `astratra-web-browser` : fonctions
 * pures, rien n'est écrit ni lancé ici.
 *
 * - `createBrowserSystemdUnit` : l'unité systemd durcie (utilisateur à part,
 *   mémoire et processeur bornés, système en lecture seule, jeton et clé par
 *   `LoadCredential`) ; seuls les espaces de noms dont le cloisonnement de
 *   Chromium a besoin (user, pid, net) sont permis ;
 * - `createBrowserPm2App` : une entrée pm2, sans les protections de systemd ;
 * - `createBrowserFirewall` : les règles nftables qui interdisent à
 *   l'utilisateur du service toute sortie vers une adresse non publique, sauf
 *   le résolveur DNS et le relais de sortie du service ;
 * - `createBrowserAppArmorProfile` : le profil qui permet au binaire de
 *   Chromium de créer son espace de noms (Ubuntu 23.10 et suivants) ;
 * - `browserSetupFiles` : tout cela d'un coup, avec la marche à suivre.
 *
 * Le jeton et la clé de signature ne sont jamais écrits dans un fichier
 * généré (ces fichiers finissent dans git) : on passe leur CHEMIN.
 */

const path = require('path');
const { BLOCKED_IPV4, BLOCKED_IPV6 } = require('../address');

const SCRIPT = path.resolve(__dirname, 'cli.js');
const SECRET_ENV = /^WEB_BROWSER_TOKEN$|^WEB_BROWSER_SIGNING_KEY$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const NAME = /^[a-z_][a-z0-9_-]*$/;

function fail(message) {
  throw new TypeError(message);
}

function safeValue(value, name) {
  const text = String(value);
  // eslint-disable-next-line no-control-regex -- une fin de ligne écrirait d'autres directives
  if (/[\u0000-\u001f\u007f]/.test(text)) fail(`${name}: control characters are not allowed.`);
  return text;
}

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${name}: absolute path expected.`);
  return safeValue(value, name);
}

function portOf(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail(`${name}: 1 to 65535.`);
  return value;
}

function httpsUrl(value, name) {
  let url;
  try {
    url = new URL(String(value));
  } catch (_error) {
    url = null;
  }
  if (!url || url.protocol !== 'https:') fail(`${name}: an https address.`);
  return safeValue(url.href, name);
}

/** L'environnement WEB_BROWSER_* du service. */
function browserServiceEnv(options = {}) {
  const env = {};
  if (options.port !== undefined) env.WEB_BROWSER_PORT = String(portOf(options.port, 'port'));
  if (options.proxyPort !== undefined) env.WEB_BROWSER_PROXY_PORT = String(portOf(options.proxyPort, 'proxyPort'));
  if (options.maxContexts !== undefined) {
    if (!Number.isInteger(options.maxContexts) || options.maxContexts < 1 || options.maxContexts > 16) fail('maxContexts: 1 to 16.');
    env.WEB_BROWSER_MAX_CONTEXTS = String(options.maxContexts);
  }
  if (options.queueMs !== undefined) {
    if (!Number.isInteger(options.queueMs) || options.queueMs < 0) fail('queueMs: non-negative integer.');
    env.WEB_BROWSER_QUEUE_MS = String(options.queueMs);
  }
  if (options.infoUrl !== undefined) env.WEB_BROWSER_INFO_URL = httpsUrl(options.infoUrl, 'infoUrl');
  if (options.signatureAgent !== undefined) env.WEB_BROWSER_SIGNATURE_AGENT = httpsUrl(options.signatureAgent, 'signatureAgent');
  if (options.browsersPath !== undefined) env.PLAYWRIGHT_BROWSERS_PATH = absolute(options.browsersPath, 'browsersPath');
  if (options.tokenFile !== undefined) env.WEB_BROWSER_TOKEN_FILE = absolute(options.tokenFile, 'tokenFile');
  if (options.signingKeyFile !== undefined) env.WEB_BROWSER_SIGNING_KEY_FILE = absolute(options.signingKeyFile, 'signingKeyFile');
  for (const [name, value] of Object.entries(options.env || {})) {
    if (!ENV_NAME.test(name)) fail(`env.${name}: invalid variable name.`);
    if (SECRET_ENV.test(name)) fail(`env.${name}: pass a file path (tokenFile, signingKeyFile) — generated files end up in git.`);
    if (name === 'WEB_BROWSER_UNSAFE_NO_FIREWALL') fail('env.WEB_BROWSER_UNSAFE_NO_FIREWALL: never in a deployment.');
    env[name] = safeValue(value, `env.${name}`);
  }
  return env;
}

function quoteArg(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value.replace(/%/g, '%%');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function quoteEnv(name, value) {
  return `"${name}=${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/**
 * L'unité systemd du service.
 * @param {object} options
 * @param {string} options.node              le binaire node (chemin absolu).
 * @param {string} options.user              l'utilisateur système du service (ex. navigateur).
 * @param {string} options.tokenFile         le fichier du jeton (lu par LoadCredential).
 * @param {string} [options.script]          Défaut : la commande du paquet.
 * @param {string} [options.signingKeyFile]  la clé Web Bot Auth (LoadCredential), avec signatureAgent.
 * @param {string} [options.memoryMax]       Défaut "2G".
 * @param {string} [options.memoryHigh]
 * @param {string} [options.cpuQuota]        Défaut "200%".
 * @param {number} [options.tasksMax]        Défaut 512.
 */
function createBrowserSystemdUnit(options = {}) {
  const node = absolute(options.node, 'node');
  const script = options.script === undefined ? SCRIPT : absolute(options.script, 'script');
  const user = safeValue(options.user || '', 'user');
  if (!NAME.test(user) || user === 'root') fail('user: a dedicated system user (not root) is required.');
  const group = options.group === undefined ? null : safeValue(options.group, 'group');
  if (group !== null && !NAME.test(group)) fail('group: invalid name.');
  if (options.tokenFile === undefined) fail('tokenFile: the service refuses to start without a token.');
  if ((options.signingKeyFile === undefined) !== (options.signatureAgent === undefined)) fail('signingKeyFile and signatureAgent go together.');
  const size = (value, name) => {
    const text = safeValue(value, name);
    if (!/^\d+[KMGT]?$/.test(text)) fail(`${name}: e.g. "2G".`);
    return text;
  };
  const cpuQuota = safeValue(options.cpuQuota ?? '200%', 'cpuQuota');
  if (!/^\d+%$/.test(cpuQuota)) fail('cpuQuota: e.g. "200%".');
  const tasksMax = options.tasksMax ?? 512;
  if (!Number.isInteger(tasksMax) || tasksMax < 64) fail('tasksMax: 64 or more.');
  const restartSec = options.restartSec ?? 5;
  if (!Number.isInteger(restartSec) || restartSec < 0) fail('restartSec: non-negative integer.');
  const description = safeValue(options.description || 'Astratra integrated web browser (read-only)', 'description');
  const workingDirectory = options.workingDirectory === undefined ? path.dirname(script) : absolute(options.workingDirectory, 'workingDirectory');

  const { tokenFile, signingKeyFile, ...rest } = options;
  const env = browserServiceEnv(rest);
  const lines = [
    '[Unit]',
    `Description=${description}`,
    'After=network-online.target nftables.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${user}`
  ];
  if (group) lines.push(`Group=${group}`);
  lines.push(
    `WorkingDirectory=${quoteArg(workingDirectory)}`,
    `ExecStart=${quoteArg(node)} ${quoteArg(script)} serve`,
    'StateDirectory=astratra-web-browser',
    'StateDirectoryMode=0700',
    'Environment="HOME=%S/astratra-web-browser"',
    'Environment=NODE_ENV=production'
  );
  if (options.environmentFile !== undefined) lines.push(`EnvironmentFile=${absolute(options.environmentFile, 'environmentFile')}`);
  /* Le jeton et la clé : lisibles par ce service seul, jamais dans l'unité. */
  lines.push(`LoadCredential=browser-token:${absolute(tokenFile, 'tokenFile')}`, 'Environment="WEB_BROWSER_TOKEN_FILE=%d/browser-token"');
  if (signingKeyFile !== undefined) {
    lines.push(`LoadCredential=browser-signing-key:${absolute(signingKeyFile, 'signingKeyFile')}`, 'Environment="WEB_BROWSER_SIGNING_KEY_FILE=%d/browser-signing-key"');
  }
  for (const [name, value] of Object.entries(env)) lines.push(`Environment=${quoteEnv(name, value)}`);
  lines.push(
    'Restart=on-failure',
    `RestartSec=${restartSec}`,
    'TimeoutStopSec=15',
    `MemoryMax=${size(options.memoryMax ?? '2G', 'memoryMax')}`
  );
  if (options.memoryHigh !== undefined) lines.push(`MemoryHigh=${size(options.memoryHigh, 'memoryHigh')}`);
  lines.push(
    `CPUQuota=${cpuQuota}`,
    `TasksMax=${tasksMax}`,
    '# Hardening. Chromium keeps its own sandbox: it needs user, pid and net namespaces.',
    '# No MemoryDenyWriteExecute: the JavaScript engine compiles code at run time.',
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'ProtectHostname=yes',
    'ProtectProc=invisible',
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK',
    'RestrictNamespaces=user pid net',
    'RestrictRealtime=yes',
    'RestrictSUIDSGID=yes',
    'LockPersonality=yes',
    'SystemCallArchitectures=native',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'UMask=0077'
  );
  for (const writable of options.readWritePaths || []) lines.push(`ReadWritePaths=${quoteArg(absolute(writable, 'readWritePaths'))}`);
  lines.push('', '[Install]', 'WantedBy=multi-user.target', '');
  return lines.join('\n');
}

/**
 * Une entrée pm2. ATTENTION : pm2 ne donne aucune des protections de systemd
 * (utilisateur à part, système en lecture seule…) ; le pare-feu reste
 * obligatoire, et il faut lancer pm2 sous l'utilisateur du service.
 */
function createBrowserPm2App(options = {}) {
  const script = options.script === undefined ? SCRIPT : absolute(options.script, 'script');
  const name = options.name === undefined ? 'astratra-web-browser' : safeValue(options.name, 'name');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) fail('name: letters, digits, dot, dash, underscore.');
  if (options.tokenFile === undefined) fail('tokenFile: the service refuses to start without a token.');
  const app = {
    name,
    script,
    args: 'serve',
    ...(options.node !== undefined ? { interpreter: absolute(options.node, 'node') } : {}),
    cwd: options.cwd === undefined ? path.dirname(script) : absolute(options.cwd, 'cwd'),
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_restarts: options.maxRestarts ?? 10,
    restart_delay: options.restartDelay ?? 5000,
    kill_timeout: options.killTimeout ?? 15000,
    max_memory_restart: options.maxMemoryRestart ?? '2G',
    env: { NODE_ENV: 'production', ...browserServiceEnv(options) }
  };
  if (!/^\d+[KMG]?$/.test(String(app.max_memory_restart))) fail('maxMemoryRestart: e.g. "2G".');
  return app;
}

function nftAddress(prefix, bits) {
  return `${prefix}/${bits}`;
}

/**
 * Les règles nftables (à charger par `nft -f`) : l'utilisateur du service ne
 * peut sortir que vers des adresses publiques, son résolveur DNS et son
 * relais de sortie local. Toute autre adresse est jetée en sortie : la
 * connexion échoue tout de suite (EPERM), ce que vérifie le contrôle au
 * démarrage.
 * @param {object} [options]
 * @param {string} [options.user]          Défaut "navigateur".
 * @param {number} [options.proxyPort]     Défaut 5009.
 * @param {string[]} [options.dnsServers]  Défaut ["127.0.0.53"] (systemd-resolved).
 * @param {string} [options.table]         Défaut "astratra_navigateur".
 */
function createBrowserFirewall(options = {}) {
  const user = safeValue(options.user ?? 'navigateur', 'user');
  if (!NAME.test(user) || user === 'root') fail('user: a dedicated system user (not root).');
  const table = safeValue(options.table ?? 'astratra_navigateur', 'table');
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) fail('table: letters, digits and underscores.');
  const proxyPort = portOf(options.proxyPort ?? 5009, 'proxyPort');
  const dnsServers = options.dnsServers ?? ['127.0.0.53'];
  if (!Array.isArray(dnsServers) || !dnsServers.length) fail('dnsServers: at least one resolver address.');
  const net = require('net');
  for (const server of dnsServers) if (!net.isIP(String(server))) fail(`dnsServers: ${String(server).slice(0, 40)} is not an IP address.`);
  const dnsLines = dnsServers.flatMap((server) => {
    const family = net.isIPv6(server) ? 'ip6' : 'ip';
    return [`    ${family} daddr ${server} udp dport 53 accept`, `    ${family} daddr ${server} tcp dport 53 accept`];
  });
  return [
    '#!/usr/sbin/nft -f',
    `# Astratra web browser: user "${user}" may reach public addresses only.`,
    '# Generated by @astratra/web-search (createBrowserFirewall). Load with: nft -f <this file>',
    `table inet ${table}`,
    `delete table inet ${table}`,
    `table inet ${table} {`,
    '  chain output {',
    '    type filter hook output priority 0; policy accept;',
    `    meta skuid != "${user}" return`,
    '    ct state established,related accept',
    `    ip daddr 127.0.0.1 tcp dport ${proxyPort} accept comment "browser egress relay"`,
    ...dnsLines,
    `    ip daddr { ${BLOCKED_IPV4.map(([prefix, bits]) => nftAddress(prefix, bits)).join(', ')} } drop comment "non-public IPv4"`,
    '    ip6 daddr != 2000::/3 drop comment "IPv6 outside global unicast"',
    `    ip6 daddr { ${BLOCKED_IPV6.filter(([prefix]) => /^[23]/.test(prefix)).map(([prefix, bits]) => nftAddress(prefix, bits)).join(', ')} } drop comment "reserved IPv6 inside 2000::/3"`,
    '  }',
    '}',
    ''
  ].join('\n');
}

/**
 * Le profil AppArmor du binaire de Chromium (Ubuntu 23.10 et suivants
 * restreignent les espaces de noms non privilégiés : sans lui, le
 * cloisonnement de Chromium ne démarre pas, et le service refuse de démarrer).
 * @param {{ chromiumPath: string, name?: string }} options
 */
function createBrowserAppArmorProfile(options = {}) {
  const binary = absolute(options.chromiumPath, 'chromiumPath');
  if (/[\s"{}]/.test(binary)) fail('chromiumPath: no spaces, quotes or braces.');
  const name = safeValue(options.name ?? 'astratra-chromium', 'name');
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) fail('name: letters, digits, dash, underscore.');
  return [
    '# Astratra web browser: lets Chromium create its sandbox namespaces.',
    '# Generated by @astratra/web-search (createBrowserAppArmorProfile).',
    'abi <abi/4.0>,',
    'include <tunables/global>',
    '',
    `profile ${name} ${binary} flags=(unconfined) {`,
    '  userns,',
    '',
    `  include if exists <local/${name}>`,
    '}',
    ''
  ].join('\n');
}

/**
 * Tous les fichiers d'un déploiement, et la marche à suivre.
 * @returns {Record<string, string>}
 */
function browserSetupFiles(options = {}) {
  const user = options.user ?? 'navigateur';
  const proxyPort = options.proxyPort ?? 5009;
  const files = {
    'astratra-web-browser.service': createBrowserSystemdUnit({ ...options, user, proxyPort }),
    'astratra-web-browser.nft': createBrowserFirewall({ user, proxyPort, dnsServers: options.dnsServers, table: options.table })
  };
  if (options.chromiumPath) files['astratra-chromium.apparmor'] = createBrowserAppArmorProfile({ chromiumPath: options.chromiumPath });
  const tokenFile = options.tokenFile;
  files['INSTALL.md'] = [
    '# Navigateur intégré Astratra — installation (en root)',
    '',
    `1. Utilisateur système : \`useradd --system --home-dir /var/lib/astratra-web-browser --shell /usr/sbin/nologin ${user}\``,
    `2. Jeton : \`astratra-web-browser token --out ${tokenFile}\` (fichier à root, mode 600 ; systemd le passe au service).`,
    '3. Pare-feu : copier `astratra-web-browser.nft` dans `/etc/nftables.d/` (ou l\'inclure depuis `/etc/nftables.conf`),',
    '   puis `nft -f /etc/nftables.d/astratra-web-browser.nft` et `systemctl enable nftables`.',
    ...(files['astratra-chromium.apparmor']
      ? ['4. AppArmor (Ubuntu 23.10 et suivants) : copier `astratra-chromium.apparmor` dans `/etc/apparmor.d/astratra-chromium`,', '   puis `apparmor_parser -r /etc/apparmor.d/astratra-chromium`.']
      : ['4. AppArmor (Ubuntu 23.10 et suivants) : relancer `setup` avec `--chromium <chemin de chrome-headless-shell>` pour obtenir le profil.']),
    '5. Service : copier `astratra-web-browser.service` dans `/etc/systemd/system/`, puis',
    '   `systemctl daemon-reload && systemctl enable --now astratra-web-browser`.',
    '6. Contrôle : `journalctl -u astratra-web-browser -n 50` doit montrer « isolation ok » ;',
    `   \`curl -s -H "Authorization: Bearer $(cat ${tokenFile})" http://127.0.0.1:${options.port ?? 5008}/health\`.`,
    '',
    'Le service refuse de démarrer s\'il peut joindre le réseau interne : le pare-feu doit rester chargé.',
    ''
  ].join('\n');
  return files;
}

module.exports = {
  browserServiceEnv,
  createBrowserSystemdUnit,
  createBrowserPm2App,
  createBrowserFirewall,
  createBrowserAppArmorProfile,
  browserSetupFiles,
  BROWSER_CLI: SCRIPT
};
