/**
 * Les adresses IP qu'une lecture de page a le droit de joindre : seulement
 * l'Internet public. Refusés : boucle locale, réseaux privés, link-local (dont
 * les métadonnées des nuages, 169.254.169.254), CGNAT, multicast, plages de
 * documentation et réservées ; en IPv6, tout ce qui n'est pas unicast global
 * (2000::/3), les adresses IPv4 encapsulées (::ffff:…, NAT64, 6to4, Teredo) et
 * les plages locales.
 */

const net = require('net');

/* Les mêmes listes servent au pare-feu du navigateur (createBrowserFirewall). */
const BLOCKED_IPV4 = Object.freeze([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]);
/* En IPv6, seul 2000::/3 (unicast global) est public, moins ces plages. */
const BLOCKED_IPV6 = Object.freeze([
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
]);

const blocked4 = new net.BlockList();
for (const [prefix, bits] of BLOCKED_IPV4) blocked4.addSubnet(prefix, bits, 'ipv4');

const blocked6 = new net.BlockList();
for (const [prefix, bits] of BLOCKED_IPV6) blocked6.addSubnet(prefix, bits, 'ipv6');

/** Les 8 groupes de 16 bits d'une adresse IPv6, ou null. */
function groupsOf(address) {
  let text = String(address).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (net.isIPv4(dotted[2]) === false) return null;
    const bytes = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((part) => parseInt(part, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** Vrai seulement pour une adresse publique, joignable sans risque de SSRF. */
function isPublicAddress(address) {
  const text = String(address ?? '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(text)) return !blocked4.check(text, 'ipv4');
  if (!net.isIPv6(text)) return false;
  const groups = groupsOf(text);
  if (!groups) return false;
  /* ::ffff:a.b.c.d (IPv4 mappée) et ::a.b.c.d (compatible) : on juge l'IPv4. */
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    if (groups[5] === 0xffff) return !blocked4.check(v4, 'ipv4');
    return false;
  }
  if ((groups[0] & 0xe000) !== 0x2000) return false;
  return !blocked6.check(groups.map((g) => g.toString(16)).join(':'), 'ipv6');
}

/** Des noms d'hôte qu'on refuse sans même les résoudre. */
function isBlockedHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (net.isIP(host)) return !isPublicAddress(host);
  if (!host.includes('.')) return true;
  return /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host)
    || host.endsWith('.in-addr.arpa') || host.endsWith('.ip6.arpa');
}

module.exports = { isPublicAddress, isBlockedHostname, BLOCKED_IPV4, BLOCKED_IPV6 };
