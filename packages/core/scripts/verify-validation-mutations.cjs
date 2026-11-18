'use strict';

/*
 * Les mutations de la validation des requêtes : chaque cas casse une règle d'express-validator ou une protection, et
 * ses essais doivent échouer. Lancé à la main (npm run verify:mutations dans ce paquet).
 */
const path = require('node:path');
const { runMutations } = require('@astratra/testkit/security');

const cases = [
  ['src/validation.js', 'écriture sur un prototype', "if (!isObjectLike(object) || segments.some((s) => FORBIDDEN.has(s))) return;", 'if (!isObjectLike(object)) return;'],
  ['src/validation.js', 'propriété héritée lue', " || !Object.hasOwn(current, segment)) return undefined;", ') return undefined;'],
  ['src/validation.js', '__proto__ lu', "if (FORBIDDEN.has(segment) || (!isObjectLike(current)", 'if ((!isObjectLike(current)'],
  ['src/validation.js', 'joker sur __proto__', "const ownKeys = Object.keys(obj).filter((k) => !FORBIDDEN.has(k));", 'const ownKeys = Object.keys(obj);'],
  ['src/validation.js', 'conversion qui plante', '  } catch {\n    return Object.prototype.toString.call(value);\n  }', '  } finally {\n    // rien\n  }'],
  ['src/validation.js', 'optional falsy ignoré', "(v) => (optional === 'falsy' ? v : true)", '(v) => true'],
  ['src/validation.js', 'bail sans effet', '    if (context.errors.length > 0) throw new ValidationHalt();', ''],
  ['src/validation.js', 'tableau validé en bloc', '    for (const item of Array.isArray(value) ? value : [value]) {', '    for (const item of [value]) {'],
  ['src/validation.js', 'tableau nettoyé en bloc', 'context.setData(path, values !== value ? next[0] : next, location);', 'context.setData(path, next[0], location);'],
  ['src/validation.js', 'check sans regroupement', '      if (instances.length > 1 && locationCount > 1 && !group.includes(\'*\')) {', '      if (false) {'],
  ['src/validation.js', 'hide sans effet', "    if (this.visibility.type === 'hidden') {", "    if (false) {"],
  ['src/validation.js', 'données invalides retenues', "      if (onlyValid && context.errors.some(", '      if (false && context.errors.some('],
  ['src/validation.js', 'promesse niée ignorée', '      if ((!isPromise && failed) || (isPromise && negated)) context.addError', '      if (!isPromise && failed) context.addError'],
  ['src/validation.js', 'message en fonction non appelé', "msg: typeof msg === 'function' ? msg(value, meta) : msg,", 'msg,'],
  ['src/validation.js', 'tableau créé comme objet', "current[segment] = /^\\d+$/.test(segments[i + 1]) ? [] : {};", 'current[segment] = {};'],
  ['src/validators.js', 'adresse sans longueur totale', '  if (!o.ignore_max_length && str.length > DEFAULT_MAX_EMAIL_LENGTH) return false;', ''],
  ['src/validators.js', 'émoji compté double', '  const len = str.length - presentation.length - surrogates.length;', '  const len = str.length - presentation.length;'],
  ['src/validators.js', 'points Gmail gardés', "    if (o.gmail_remove_dots) parts[0] = parts[0].replace(/\\.+/g, (m) => (m.length > 1 ? m : ''));", ''],
  ['src/validators.js', 'minimum d’un entier ignoré', "ok('min', (v) => str >= v) && ", ''],
  ['src/validators.js', 'domaine de premier niveau non vérifié', "    if (!o.allow_numeric_tld && !/^([a-z\\u00A1-\\u00A8\\u00AA-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFEF]{2,}|xn[a-z0-9-]{2,})$/i.test(tld)) return false;", ''],
  ['src/validators.js', 'demi-caractère mesuré', '  if (!str.isWellFormed()) return null;', ''],
].map(([file, name, before, after]) => ({ file, name, before, after }));

const report = runMutations({
  cwd: path.resolve(__dirname, '..'),
  cases,
  command: ['npx', ['jest', '__tests__/validation.test.js', '__tests__/validateMiddleware.test.js', '--testTimeout=60000']],
  onResult: (r) => process.stdout.write(`${r.killed ? 'tuée    ' : 'SURVIT  '} ${r.name}\n`),
});
if (!report.allKilled) {
  process.stderr.write(`${report.survivors.length} mutation(s) ont survécu.\n`);
  process.exit(1);
}
process.stdout.write(`${report.results.length} mutations, toutes tuées.\n`);
