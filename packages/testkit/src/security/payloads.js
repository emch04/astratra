'use strict';

/**
 * Le catalogue d'entrées hostiles, partagé par tous les essais d'attaque. Chaque liste est écrite ici (aucune liste
 * extérieure recopiée) ; les valeurs ne visent que l'application testée, jamais un service tiers. Les textes sont des
 * chaînes, les entrées qui ne s'écrivent pas en texte valide (octets) sont des Buffer, et les entrées structurées
 * (opérateurs Mongo, clés piégées) sont des objets fabriqués à chaque appel.
 */

const LONE_HIGH = '\uD800';
const LONE_LOW = '\uDC00';

const sqlInjection = [
  "' OR '1'='1",
  "' OR 1=1 --",
  '" OR ""="',
  "'; DROP TABLE users; --",
  "1; SELECT pg_sleep(5) --",
  "1 AND SLEEP(5)",
  "' UNION SELECT NULL, password FROM users --",
  "admin'--",
  "1' ORDER BY 99 --",
  "%27%20OR%201%3D1",
  "\\'; SELECT 1; --",
  "1/**/OR/**/1=1",
];

const xss = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '"><script>alert(1)</script>',
  "'-alert(1)-'",
  '</textarea><script>alert(1)</script>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<iframe srcdoc="<script>alert(1)</script>">',
  '{{constructor.constructor("alert(1)")()}}',
];

const templateInjection = ['${7*7}', '{{7*7}}', '#{7*7}', '<%= 7*7 %>', '${{7*7}}', '{{=7*7}}', '@(7*7)', '[[7*7]]'];

const pathTraversal = [
  '../etc/passwd',
  '../../../../etc/passwd',
  '..\\..\\windows\\win.ini',
  '%2e%2e%2fetc%2fpasswd',
  '%252e%252e%252fetc%252fpasswd',
  '..%2f..%2fetc%2fpasswd',
  '..%c0%afetc%c0%afpasswd',
  '....//....//etc/passwd',
  '/etc/passwd',
  'C:\\Windows\\win.ini',
  'file.txt\u0000.png',
  './.env',
  '.git/config',
  '\\\\server\\share\\file',
];

const commandInjection = ['; id', '| id', '&& id', '`id`', '$(id)', '\nid', "'; id #", '%0aid', '|| id'];

const headerInjection = ['value\r\nSet-Cookie: injected=1', 'value\nX-Injected: 1', 'value%0d%0aX-Injected:%201', 'value\r\n\r\n<html>', 'value\u2028X-Injected: 1'];

const unicode = [
  LONE_HIGH,
  LONE_LOW,
  `a${LONE_HIGH}b`,
  `${LONE_LOW}${LONE_HIGH}`,
  '\u0000',
  'a\u0000b',
  '\u202Eevil\u202C', // texte retourné
  '\u200B\u200C\u200D\uFEFF', // largeur nulle
  'admin\u200B',
  'ａｄｍｉｎ', // pleine chasse
  'аdmin', // « а » cyrillique
  'e\u0301', // é décomposé
  '\u00E9', // é composé
  'ﬁ', // ligature
  '𝕒𝕕𝕞𝕚𝕟',
  '\uFFFF\uFFFE',
  '🇫🇷👨\u200D👩\u200D👧',
  'İ', // majuscule turque
];

/** Des octets qui ne forment pas de l'UTF-8 valide. */
function invalidUtf8() {
  return [
    Buffer.from([0xc0, 0xaf]), // « / » trop long
    Buffer.from([0xe0, 0x80, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]), // demi-caractère encodé
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0x80]),
    Buffer.from([0xf8, 0x88, 0x80, 0x80, 0x80]),
    Buffer.from([0x61, 0x00, 0x62]),
  ];
}

const numbers = [0, -0, 1, -1, 0.1, -1e-300, 1e308, -1e308, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, Number.MIN_SAFE_INTEGER, 2 ** 31, 2 ** 32, 2 ** 53, NaN, Infinity, -Infinity];

const numericStrings = ['0', '-0', '00', '0x10', '0o10', '0b10', '1e3', ' 1', '1 ', '1_000', '١٢٣', '+1', '.5', '5.', 'NaN', 'Infinity', '9'.repeat(400), '-', ''];

/** Les opérateurs Mongo qu'un formulaire ne doit jamais faire passer pour une valeur. */
function noSqlOperators() {
  return [
    { $ne: null },
    { $gt: '' },
    { $regex: '.*' },
    { $where: 'sleep(100)' },
    { $expr: { $eq: [1, 1] } },
    { $in: ['admin'] },
    { 'a.b': 1 },
    { $or: [{ a: 1 }, { b: 1 }] },
  ];
}

/** Des objets aux clés piégées, fabriqués par JSON.parse (seule façon d'obtenir une vraie clé « __proto__ »). */
function prototypePollution() {
  return [
    JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
    JSON.parse('{"a":{"__proto__":{"polluted":true}}}'),
    JSON.parse('{"__proto__":[1,2,3]}'),
    JSON.parse('{"prototype":{"polluted":true}}'),
  ];
}

const prototypeKeys = ['__proto__', 'constructor', 'prototype', '__defineGetter__', 'hasOwnProperty', 'toString', 'valueOf'];

/** Des adresses qui désignent la machine elle-même ou le réseau interne sous une autre écriture. */
const ssrfUrls = [
  'http://127.0.0.1/',
  'http://127.1/',
  'http://0/',
  'http://0.0.0.0/',
  'http://2130706433/',
  'http://0x7f000001/',
  'http://0177.0.0.1/',
  'http://[::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[0:0:0:0:0:ffff:7f00:1]/',
  'http://localhost/',
  'http://localhost./',
  'http://LOCALHOST/',
  'http://127.0.0.1.nip.io/',
  'http://169.254.169.254/latest/meta-data/',
  'http://[fd00:ec2::254]/',
  'http://metadata.google.internal/',
  'http://10.0.0.1/',
  'http://192.168.1.1/',
  'http://172.16.0.1/',
  'http://user@127.0.0.1/',
  'http://example.test@127.0.0.1/',
  'http://127.0.0.1:22/',
  'file:///etc/passwd',
  'gopher://127.0.0.1:6379/_INFO',
  'ftp://127.0.0.1/',
  'dict://127.0.0.1:11211/',
];

/** Des adresses IPv6 d'un même bloc /64 : une limite par adresse exacte se contourne en changeant les derniers groupes. */
const ipv6SameSubnet = ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2:abcd::1', '2001:0db8:0001:0002:0000:0000:0000:0003', '2001:db8:1:2::1%eth0'];

const ipSpoofHeaders = [
  { 'x-forwarded-for': '127.0.0.1' },
  { 'x-forwarded-for': '1.2.3.4, 127.0.0.1' },
  { 'x-real-ip': '127.0.0.1' },
  { 'x-client-ip': '127.0.0.1' },
  { forwarded: 'for=127.0.0.1' },
  { 'cf-connecting-ip': '127.0.0.1' },
  { 'true-client-ip': '127.0.0.1' },
];

const filenames = [
  '../../evil.sh',
  '..\\..\\evil.bat',
  'evil.php.jpg',
  'evil.jpg.php',
  'evil.svg',
  'evil.html',
  'image.png\u0000.php',
  'CON',
  'con.txt',
  'NUL',
  'aux.js',
  ' leading-space.txt',
  'trailing-dot.',
  '.htaccess',
  '\u202Egpj.exe',
  'a'.repeat(300) + '.txt',
  'é'.normalize('NFD') + '.txt',
  '',
  '.',
  '..',
];

const emails = [
  'a@example.test',
  'A@EXAMPLE.TEST',
  ' a@example.test',
  'a@example.test ',
  'a+tag@example.test',
  '"a b"@example.test',
  'a@b',
  'a@@example.test',
  'a@example.test\r\nBcc: other@example.test',
  'a@example.test%0aBcc:other@example.test',
  'a@[127.0.0.1]',
  'é@example.test',
  'a@ехample.test', // « е » et « х » cyrilliques
  'a'.repeat(250) + '@example.test',
  '<a@example.test>',
  'a@example.test,b@example.test',
];

/** Des types de contenu trompeurs. */
const contentTypes = ['application/json; charset=utf-7', 'application/x-www-form-urlencoded', 'text/plain', 'application/json, text/plain', 'APPLICATION/JSON', 'application/json\u0000', 'multipart/form-data; boundary=', 'application/vnd.api+json', ''];

/** Des mots de passe faibles ou piégés. */
const passwords = ['', ' ', 'password', '123456', 'azerty', 'a'.repeat(1025), 'pa\u0000ss', `pass${LONE_HIGH}word`, 'é'.normalize('NFD') + 'tait', '\u200Bpassword'];

const all = () => [...sqlInjection, ...xss, ...templateInjection, ...pathTraversal, ...commandInjection, ...headerInjection, ...unicode, ...numericStrings, ...ssrfUrls, ...filenames, ...emails, ...passwords];

// Des noms seuls et des « ...require() » dans l'objet exporté : Node les lit sans exécuter le fichier, pour les
// imports nommés d'un module ES.
const payloads = {
  sqlInjection,
  xss,
  templateInjection,
  pathTraversal,
  commandInjection,
  headerInjection,
  unicode,
  invalidUtf8,
  numbers,
  numericStrings,
  noSqlOperators,
  prototypePollution,
  prototypeKeys,
  ssrfUrls,
  ipv6SameSubnet,
  ipSpoofHeaders,
  filenames,
  emails,
  contentTypes,
  passwords,
  all,
};

module.exports = { payloads };
