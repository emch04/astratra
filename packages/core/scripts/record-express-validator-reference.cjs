'use strict';

/*
 * Enregistre, une fois, ce que fait express-validator 7.3 (et validator.js 13.15 dessous) sur un corpus de chaînes et
 * de requêtes, pour comparer la validation de core (__tests__/fixtures/express-validator-reference.json).
 * express-validator n'est plus une dépendance d'Astratra : le chemin d'un projet qui l'a installé est donné.
 *   node scripts/record-express-validator-reference.cjs /chemin/vers/node_modules/express-validator
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require(path.resolve(process.argv[2]));
const { createRandom } = require('@astratra/testkit/security');
const { runCase, compact } = require('../__tests__/helpers/validationSpec.cjs');

const random = createRandom('express-validator-reference');
const cases = [];
const one = (location, field, steps, extra = {}) => ({ location, fields: field, steps, ...extra });
const add = (id, chains, req, extra = {}) => cases.push({ id, chains, req, ...extra });

// Les valeurs essayées partout : textes, nombres, booléens, null, tableaux, objets.
const VALUES = ['', ' ', 'abc', '  espaces  ', 'Élève', '0', '1', '-1', '42', '3.14', 'true', 'false', 'null', 0, 1, -7, 3.5, true, false, null, [], ['a', ' b '], [1, '2', null], {}, { a: 1 }, '👍🏽', '\u0000', 'a\nb'];

// A. Les vérifications standard, avec leurs options.
const EMAILS = [
  'a@b.co', 'test.user+tag@example.com', '"quoted user"@example.com', '"quo\\"ted"@example.com', 'user@sub.example.co.uk', 'élève@exemple.fr', 'user@xn--bcher-kva.example',
  'a@b.c', 'user@localhost', 'user@[127.0.0.1]', 'user@127.0.0.1', 'user@[IPv6:::1]', 'Name <user@example.com>', '"Name, Jr" <u@example.com>', 'Name<user@example.com>', '<user@example.com>',
  `${'a'.repeat(64)}@example.com`, `${'a'.repeat(65)}@example.com`, `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`, `u@${'b'.repeat(63)}.com`, `u@${'b'.repeat(64)}.com`, `${'a'.repeat(60)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.com`,
  'user..dots@example.com', '.user@example.com', 'user.@example.com', 'user@-example.com', 'user@example-.com', 'user@exa_mple.com', 'user@example.123', 'user@example.c0m', 'user@ex ample.com',
  'user@@example.com', '@example.com', 'user@', '', 'user@example..com', 'UPPER@EXAMPLE.COM', 'user@ｅｘａｍｐｌｅ.com', 'user\u0000@example.com', 'us"er@example.com', 'user@example.com.', ' user@example.com',
  'ab@gmail.com', 'abcdef@gmail.com', 'abc.def+x@gmail.com', 'a.b.c.d.e.f@googlemail.com', 'x+y@example.com', 'user@sub_domain.example.com', 'user@exaémple.fr', 'user@例え.jp', '\ud800@example.com', 'user@exa\udc00mple.com',
];
const EMAIL_OPTIONS = [undefined, { allow_display_name: true }, { require_display_name: true }, { allow_utf8_local_part: false }, { require_tld: false }, { allow_ip_domain: true }, { domain_specific_validation: true }, { blacklisted_chars: '+' }, { host_blacklist: ['example.com'] }, { host_whitelist: ['example.com'] }, { ignore_max_length: true }, { allow_underscores: true }];
for (const options of EMAIL_OPTIONS) {
  for (const email of EMAILS) add(`isEmail ${JSON.stringify(options || {})} ${email.slice(0, 40)}`, [one('body', 'v', [options ? ['isEmail', options] : ['isEmail']])], { body: { v: email } });
}

const STANDARD = [
  ['isLength', [{ min: 2 }], [{ max: 3 }], [{ min: 1, max: 5 }], [{ discreteLengths: [2, 4] }], [{ min: 0, max: 0 }]],
  ['isInt', [], [{ min: 1 }], [{ max: 10 }], [{ min: 1, max: 10 }], [{ gt: 0 }], [{ lt: 5 }], [{ allow_leading_zeroes: false }], [{ min: null }]],
  ['isFloat', [], [{ min: 0 }], [{ max: 1 }], [{ locale: 'fr-FR' }], [{ locale: 'ar' }], [{ gt: 1 }], [{ lt: 2 }], [{ locale: 'inconnue' }]],
  ['isNumeric', [], [{ no_symbols: true }], [{ locale: 'fr-FR' }]],
  ['isBoolean', [], [{ loose: true }], [{ strict: true }]],
  ['isIn', [['a', 'b', 'abc']], [[1, 2, '3', null]], [{ abc: 1, true: 2 }], ['abcdef'], [['__proto__', 'constructor']]],
  ['isUUID', [], [4], ['all'], [7], ['nil'], ['loose']],
  ['isMongoId', []],
  ['isHexadecimal', []],
  ['isIP', [], [4], [6], ['4']],
  ['isFQDN', [], [{ require_tld: false }], [{ allow_underscores: true }], [{ allow_trailing_dot: true }], [{ allow_wildcard: true }], [{ allow_numeric_tld: true }]],
  ['contains', ['b'], ['B', { ignoreCase: true }], ['a', { minOccurrences: 2 }], [1]],
  ['matches', [{ $re: ['^a.c$', ''] }], ['^A', 'i'], [{ $re: ['b', 'g'] }], ['\\d{2}']],
  ['equals', ['abc'], ['5'], ['true']],
  ['isEmpty', [], [{ ignore_whitespace: true }]],
  ['notEmpty', [], [{ ignore_whitespace: true }]],
  ['isByteLength', [{ min: 2, max: 4 }], [{ max: 1 }]],
];
const SPECIAL = ['507f1f77bcf86cd799439011', '0x507f1f77bcf86cd7994390', 'ABCDEF', 'zz', '6ba7b810-9dad-11d1-80b4-00c04fd430c8', '6ba7b810-9dad-41d1-80b4-00c04fd430c8', '017f22e2-79b0-7cc3-98c4-dc0c0c07398f', '00000000-0000-0000-0000-000000000000', '192.168.0.1', '256.1.1.1', '::1', '2001:db8::ff00:42:8329', 'fe80::1%eth0', '1.2.3', 'example.com', 'sub_domain.example.com', 'example.com.', '*.example.com', 'example.123', 'localhost', '1,5', '1.5', '.5', '5.', '1e10', '+', '٫5', '007', '+5', '1.0', '99999999999999999999', 'yes', 'NO', 'TRUE', 'abcabc', 'xabcx', 'Abc', '❤️❤️', 'é', '\ud83d', '\ud800x'];
for (const [name, ...optionSets] of STANDARD) {
  for (const options of optionSets) {
    for (const value of [...VALUES, ...SPECIAL]) add(`${name} ${JSON.stringify(options)} ${JSON.stringify(value)}`, [one('body', 'v', [[name, ...options]])], { body: { v: value } });
  }
}

// B. Les nettoyages, sur les mêmes valeurs (tableaux compris) et un champ absent.
const DOMAINS = ['Gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'hotmail.fr', 'outlook.com', 'live.com', 'yahoo.fr', 'ymail.com', 'yandex.ua', 'ya.ru', 'example.com', 'EXAMPLE.ORG'];
const USERS = ['Jean.Dupont', 'j.e.a.n+promo', 'Ab..Cd', '+seulement', 'yahoo-user-tag', 'single', 'x'];
const NORMALIZE_OPTIONS = [undefined, { gmail_remove_dots: false }, { all_lowercase: false }, { gmail_remove_subaddress: false, gmail_convert_googlemaildotcom: false }, { yahoo_remove_subaddress: false }, { yandex_convert_yandexru: false, all_lowercase: false }];
for (const options of NORMALIZE_OPTIONS) {
  for (const domain of DOMAINS) for (const user of USERS) add(`normalizeEmail ${JSON.stringify(options || {})} ${user}@${domain}`, [one('body', 'v', [options ? ['normalizeEmail', options] : ['normalizeEmail']])], { body: { v: `${user}@${domain}` } });
  add(`normalizeEmail sans @ ${JSON.stringify(options || {})}`, [one('body', 'v', [['normalizeEmail', ...(options ? [options] : [])]])], { body: { v: 'pas-une-adresse' } });
}
const SANITIZERS = [['trim'], ['trim', 'x.*'], ['ltrim'], ['rtrim'], ['rtrim', '!'], ['escape'], ['unescape'], ['stripLow'], ['stripLow', true], ['toBoolean'], ['toBoolean', true], ['toDate'], ['toFloat'], ['toInt'], ['toInt', 16], ['blacklist', 'abc'], ['whitelist', 'a-z'], ['toLowerCase'], ['toUpperCase'], ['default', 'défaut'], ['replace', ['', null], 'vide'], ['toArray'], ['customSanitizer', { $fn: 'majuscules' }], ['customSanitizer', { $fn: 'versNombre' }], ['customSanitizer', { $fn: 'doubler' }]];
for (const steps of SANITIZERS) {
  for (const value of [...VALUES, '&lt;b&gt;&amp;', 'x.*xx.*', '2026-11-18', 'pas une date', 'FALSE', 'ff', '0x1A']) add(`${steps[0]} ${JSON.stringify(steps.slice(1))} ${JSON.stringify(value)}`, [one('body', 'v', [steps])], { body: { v: value } });
  add(`${steps[0]} ${JSON.stringify(steps.slice(1))} absent`, [one('body', 'v', [steps])], { body: {} });
}

// C. Le comportement des chaînes : optional, exists, not, bail, if, messages, emplacements, chemins, hide, matchedData.
const OPT = [[true], [false], [{ values: 'null' }], [{ values: 'falsy' }], [{ nullable: true }], [{ checkFalsy: true }], [{ values: 'undefined' }]];
for (const args of OPT) for (const value of [undefined, null, '', 0, false, 'x', '  ']) {
  add(`optional ${JSON.stringify(args)} ${JSON.stringify(value)}`, [one('body', 'v', [['optional', ...args], ['trim'], ['isLength', { min: 2 }], ['toUpperCase']])], { body: value === undefined ? {} : { v: value } });
}
for (const args of [[], [{ values: 'null' }], [{ values: 'falsy' }], [{ checkNull: true }], [{ checkFalsy: true }]]) for (const value of [undefined, null, '', 0, 'x']) {
  add(`exists ${JSON.stringify(args)} ${JSON.stringify(value)}`, [one('body', 'v', [['exists', ...args]])], { body: value === undefined ? {} : { v: value } });
}
add('not().isEmail()', [one('body', 'v', [['not'], ['isEmail'], ['isLength', { max: 3 }]])], { body: { v: 'a@b.co' } });
add('not().custom()', [one('body', 'v', [['not'], ['custom', { $fn: 'vrai' }], ['not'], ['custom', { $fn: 'leve' }]])], { body: { v: 1 } });
add('bail', [one('body', 'v', [['isEmail'], ['bail'], ['isLength', { min: 50 }]]), one('body', 'w', [['isEmail'], ['isLength', { min: 50 }]])], { body: { v: 'x', w: 'y' } });
add('bail au niveau de la requête', [one('body', 'v', [['isEmail'], ['bail', { level: 'request' }]]), one('body', 'w', [['isEmail']])], { body: { v: 'x', w: 'y' } });
add('if chaîne vraie', [one('body', 'v', [['if', { $chain: one('body', 'role', [['equals', 'admin']]) }], ['notEmpty']])], { body: { role: 'admin', v: '' } });
add('if chaîne fausse', [one('body', 'v', [['if', { $chain: one('body', 'role', [['equals', 'admin']]) }], ['notEmpty']])], { body: { role: 'user', v: '' } });
add('if fonction', [one('body', 'v', [['if', { $fn: 'aRole' }], ['notEmpty']]), one('body', 'w', [['if', { $fn: 'leve' }], ['notEmpty']])], { body: { role: 'admin', v: '', w: '' } });
for (const fn of ['vrai', 'faux', 'rienRendu', 'leve', 'leveTexte', 'promesseTenue', 'promesseRejetee', 'egalMotDePasse', 'estPair']) {
  add(`custom ${fn}`, [one('body', 'v', [['custom', { $fn: fn }]])], { body: { v: '4', password: '4' } });
  add(`not custom ${fn}`, [one('body', 'v', [['not'], ['custom', { $fn: fn }]])], { body: { v: '4', password: '4' } });
  add(`custom ${fn} avec message`, [one('body', 'v', [['custom', { $fn: fn }], ['withMessage', 'message donné']])], { body: { v: '3', password: '4' } });
}
add('withMessage fonction', [one('body', 'v', [['isEmail'], ['withMessage', { $fn: 'messageChemin' }]])], { body: { v: 'x' } });
add('message de chaîne', [one('body', 'v', [['isEmail'], ['isLength', { min: 9 }], ['withMessage', 'trop court']], { message: 'message de la chaîne' })], { body: { v: 'x' } });
add('message de chaîne fonction', [one('body', 'v', [['isEmail']], { message: { $fn: 'messageChemin' } })], { body: { v: 'x' } });
add('check dans tous les emplacements', [one('check', 'id', [['isInt']])], { body: { id: 'a' }, params: { id: '2' }, query: { id: 'b' }, headers: {}, cookies: { id: 'c' } });
add('check absent partout', [one('check', 'id', [['isInt']])], { body: {}, params: {} });
add('check présent à un seul endroit', [one('check', 'id', [['isInt']])], { body: {}, params: { id: 'x' } });
add('plusieurs champs', [one('body', ['a', 'b', 'c'], [['trim'], ['notEmpty']])], { body: { a: ' ', b: 'x' } });
add('en-tête (casse)', [one('header', 'X-Jeton', [['notEmpty'], ['isLength', { min: 3 }]])], { headers: { 'x-jeton': 'ab' } });
add('cookie', [one('cookie', 'session', [['isMongoId']])], { cookies: { session: '507f1f77bcf86cd799439011' } });
add('param et query', [one('param', 'id', [['trim'], ['notEmpty'], ['isLength', { max: 200 }]]), one('query', 'page', [['optional'], ['isInt', { min: 1 }], ['toInt']])], { params: { id: ' clé ' }, query: { page: '3' } });
add('joker sur un tableau', [one('body', 'items.*.name', [['trim'], ['notEmpty'], ['withMessage', 'nom vide']])], { body: { items: [{ name: ' a ' }, { name: '  ' }, {}, 'texte'] } });
add('joker sur un objet', [one('body', 'map.*', [['isInt']])], { body: { map: { a: '1', b: 'x', 'c.d': '2' } } });
add('joker absent', [one('body', 'children.*', [['isMongoId']])], { body: {} });
add('joker double', [one('body', 'tree.**.id', [['isInt']])], { body: { tree: { id: '1', a: { id: 'x', b: { id: '3' } }, c: [{ id: 'y' }] } } });
add('chemins imbriqués', [one('body', 'a.b.c', [['trim'], ['notEmpty']]), one('body', 'a.list[1]', [['toInt']]), one('body', '["x.y"]', [['isEmail']])], { body: { a: { b: { c: ' z ' }, list: ['1', '2'] }, 'x.y': 'nope' } });
add('nettoyage qui crée le champ', [one('body', 'nouveau.champ', [['trim']]), one('body', 'liste[2]', [['default', 'x']])], { body: {} });
add('corps absent', [one('body', 'v', [['trim'], ['notEmpty']])], {}, { undefinedBody: true });
add('valeur tableau', [one('body', 'v', [['trim'], ['isLength', { min: 2 }], ['isString']])], { body: { v: [' a ', 'bb', 3] } });
add('hide', [one('body', 'password', [['isLength', { min: 8 }], ['hide']]), one('body', 'pin', [['isInt'], ['hide', '***']])], { body: { password: 'court', pin: 'abc' } });
add('même champ deux fois', [one('body', 'v', [['trim']]), one('body', 'v', [['isEmail'], ['normalizeEmail']])], { body: { v: '  A@Gmail.com ' } });
add('optional falsy puis nettoyage', [one('body', 'v', [['trim'], ['optional', { values: 'falsy' }], ['isEmail']])], { body: { v: '   ' } });
add('toInt puis isInt', [one('body', 'n', [['toInt'], ['isInt', { min: 5 }]])], { body: { n: '3abc' } });
add('valeur du corps entier', [one('body', undefined, [['isObject']])], { body: { a: 1 } });
for (const value of [{ toString: 0 }, [[{ toString: 1 }]], { toString: 'x' }, [{ toString: null }], { valueOf: 1, toString: false }]) {
  for (const steps of [[['isIn', ['a']]], [['isEmail']], [['trim']], [['isInt']], [['notEmpty']]]) add(`valeur piégée ${JSON.stringify(value)} ${steps[0][0]}`, [one('body', 'v', steps)], { body: { v: value } });
}
add('__proto__ et constructor ne sont jamais nettoyés', [one('body', '__proto__.polluted', [['default', 'oui']]), one('body', 'constructor.prototype.x', [['default', 'oui']])], { body: {} });

// Les chaînes réelles d'Astratra (credentials et saas-kit), avec des requêtes variées.
const REAL = {
  email: [['isEmail'], ['withMessage', 'email must be a valid email address']],
  key: [['trim'], ['notEmpty'], ['isLength', { max: 200 }], ['withMessage', 'key must be between 1 and 200 characters']],
  role: [['optional'], ['isString'], ['trim'], ['notEmpty'], ['withMessage', 'role must not be empty when provided']],
  password: [['notEmpty'], ['withMessage', 'password is required']],
  title: [['trim'], ['notEmpty'], ['isLength', { max: 200 }], ['withMessage', 'title must be between 1 and 200 characters']],
  message: [['trim'], ['notEmpty'], ['isLength', { max: 5000 }], ['withMessage', 'message must be between 1 and 5000 characters']],
  value: [['isString'], ['trim'], ['notEmpty'], ['withMessage', 'value is required']],
  exists: [['exists'], ['withMessage', 'value is required']],
  optionalEmail: [['optional'], ['isEmail'], ['withMessage', 'email must be a valid email address']],
};
const REAL_VALUES = [undefined, '', '   ', 'x', 'a@b.co', 'pas une adresse', 'x'.repeat(201), 'y'.repeat(5001), 42, null, true, ['a@b.co'], { $ne: 1 }, '  Admin  ', '<script>alert(1)</script>'];
for (const [name, steps] of Object.entries(REAL)) {
  for (const value of REAL_VALUES) add(`réelle ${name} ${JSON.stringify(value)?.slice(0, 30)}`, [one(name === 'key' ? 'param' : 'body', name === 'exists' || name === 'optionalEmail' ? 'v' : name, steps)], name === 'key' ? { params: value === undefined ? {} : { key: value } } : { body: value === undefined ? {} : { [name === 'exists' || name === 'optionalEmail' ? 'v' : name]: value } });
}

// D. Des chaînes au hasard.
const POOL = [['trim'], ['notEmpty'], ['isEmail'], ['isLength', { min: 1, max: 5 }], ['isInt', { min: 0 }], ['toInt'], ['isString'], ['optional'], ['optional', { values: 'falsy' }], ['bail'], ['not'], ['isMongoId'], ['isIn', ['a', 'b', '1']], ['toLowerCase'], ['escape'], ['normalizeEmail'], ['exists'], ['custom', { $fn: 'estPair' }], ['customSanitizer', { $fn: 'doubler' }], ['matches', '^[a-z]+$'], ['isBoolean'], ['toBoolean'], ['isArray', { min: 1 }], ['isObject'], ['default', 0], ['withMessage', 'au hasard']];
for (let i = 0; i < 400; i++) {
  const steps = [];
  const n = random.int(1, 6);
  for (let j = 0; j < n; j++) {
    const step = random.pick(POOL);
    if (step[0] === 'withMessage' && !steps.some((s) => !['trim', 'toInt', 'optional', 'bail', 'not', 'toLowerCase', 'escape', 'normalizeEmail', 'customSanitizer', 'toBoolean', 'default'].includes(s[0]))) continue;
    if (step[0] === 'not' && j === n - 1) continue;
    steps.push(step);
  }
  if (steps.length && steps[steps.length - 1][0] === 'not') steps.pop();
  const value = random.pick([...VALUES, undefined, ...SPECIAL.slice(0, 12)]);
  add(`au hasard ${i}`, [one('body', 'v', steps)], { body: value === undefined ? {} : { v: value } });
}

(async () => {
  const out = { source: `express-validator ${require(path.join(path.resolve(process.argv[2]), 'package.json')).version} (validator ${require(require.resolve('validator/package.json', { paths: [path.resolve(process.argv[2])] })).version})`, cases: [] };
  for (const testCase of cases) out.cases.push({ ...testCase, expected: compact(await runCase(lib, testCase), testCase) });
  fs.writeFileSync(path.join(__dirname, '../__tests__/fixtures/express-validator-reference.json'), `${JSON.stringify(out)}\n`);
  const crashes = out.cases.filter((c) => c.expected.crash).length;
  process.stdout.write(`${(fs.statSync(path.join(__dirname, '../__tests__/fixtures/express-validator-reference.json')).size / 1e6).toFixed(1)} Mo\n`);
  process.stdout.write(`${out.cases.length} cas enregistrés (${out.source}) ; ${crashes} font planter express-validator.\n`);
})();
