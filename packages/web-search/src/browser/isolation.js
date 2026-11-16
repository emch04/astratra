/**
 * Le contrôle d'isolement, au démarrage du service : depuis le processus du
 * service (même utilisateur que Chromium, donc mêmes règles de pare-feu), on
 * tente de joindre
 * - la boucle locale, sur le port du service lui-même (il écoute : sans
 *   pare-feu, la connexion aboutit à coup sûr) ;
 * - une adresse privée de la machine (port 22), ou 10.0.0.1 ;
 * - les métadonnées du nuage, 169.254.169.254:80.
 *
 * Une sonde qui aboutit (connexion, ou refus du port par l'hôte joint) prouve
 * que l'intérieur est joignable : le service refuse de démarrer
 * (`isolation_failed`). Le pare-feu du pack jette ces paquets à la sortie : la
 * connexion échoue tout de suite (EPERM).
 */

const net = require('net');
const os = require('os');

/** La première adresse IPv4 privée de la machine, s'il y en a une. */
function privateAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(entry.address)) return entry.address;
    }
  }
  return null;
}

/**
 * Une sonde TCP.
 * @returns {Promise<'reached'|'blocked'|'timeout'|'unreachable'>}
 */
function probe({ host, port, timeoutMs, connect = net.connect }) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host, port });
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.once('connect', () => finish('reached'));
    socket.once('error', (error) => {
      const code = error?.code;
      /* ECONNREFUSED : l'hôte a répondu (rien n'écoute là) : le paquet est passé. */
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return finish('reached');
      if (code === 'EPERM' || code === 'EACCES') return finish('blocked');
      return finish('unreachable');
    });
  });
}

/**
 * @param {object} options
 * @param {number} options.servicePort
 * @param {number} [options.timeoutMs]   Défaut 1 500.
 * @param {{ name: string, host: string, port: number }[]} [options.targets]  à la place des sondes par défaut.
 * @param {Function} [options.connect]   net.connect (tests).
 * @returns {Promise<{ ok: boolean, checkedAt: string, probes: { name: string, host: string, port: number, outcome: string }[] }>}
 */
async function checkIsolation(options = {}) {
  const timeoutMs = options.timeoutMs ?? 1_500;
  const targets = options.targets || [
    { name: 'loopback', host: '127.0.0.1', port: options.servicePort },
    { name: 'private', host: privateAddress() || '10.0.0.1', port: 22 },
    { name: 'metadata', host: '169.254.169.254', port: 80 }
  ];
  const probes = await Promise.all(targets.map(async (target) => ({
    ...target,
    outcome: await probe({ host: target.host, port: target.port, timeoutMs, connect: options.connect })
  })));
  return { ok: probes.every((entry) => entry.outcome !== 'reached'), checkedAt: new Date().toISOString(), probes };
}

module.exports = { checkIsolation, privateAddress };
