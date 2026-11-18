'use strict';

const { AssertionError } = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * La chaîne d'approvisionnement, vérifiée dans les essais : le verrou npm ne doit tirer que du registre permis, en
 * https, chaque paquet avec son empreinte sha512 ; aucun paquet ne lance de script à l'installation sans avoir été
 * permis ; et les dépendances directes restent dans une liste décidée (une nouvelle dépendance se décide, elle
 * n'arrive pas en passant).
 */
function checkLockfile(lockfile, { allowedRegistries = ['https://registry.npmjs.org/'], allowInstallScripts = [], allowSha1 = false } = {}) {
  const lock = typeof lockfile === 'string' ? JSON.parse(fs.readFileSync(lockfile, 'utf8')) : lockfile;
  if (!lock || typeof lock.packages !== 'object') throw new Error('checkLockfile needs an npm lockfile v2 or v3 (with "packages").');
  const problems = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.link || !key.includes('node_modules/')) continue;
    const name = entry.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const resolved = entry.resolved;
    if (!resolved) {
      if (!entry.inBundle) problems.push({ name, key, problem: 'no "resolved" address' });
    } else if (!allowedRegistries.some((registry) => resolved.startsWith(registry))) {
      problems.push({ name, key, problem: `comes from ${resolved.split('/').slice(0, 3).join('/')} (not an allowed registry)` });
    }
    if (resolved && !entry.inBundle) {
      if (!entry.integrity) problems.push({ name, key, problem: 'no integrity hash' });
      else if (!entry.integrity.split(/\s+/).some((h) => h.startsWith('sha512-')) && !allowSha1) problems.push({ name, key, problem: `weak integrity hash (${entry.integrity.split('-')[0]})` });
    }
    if (entry.hasInstallScript && !allowInstallScripts.includes(name)) problems.push({ name, key, problem: 'runs a script at install time' });
  }
  return { passed: problems.length === 0, problems, packages: Object.keys(lock.packages).length - 1 };
}

function assertLockfile(lockfile, options = {}) {
  const report = checkLockfile(lockfile, options);
  if (!report.passed) {
    throw new AssertionError({ message: `lockfile: ${report.problems.length} problem(s):\n${report.problems.slice(0, 40).map((p) => `  - ${p.name}: ${p.problem}`).join('\n')}${report.problems.length > 40 ? '\n  …' : ''}` });
  }
  return report;
}

/**
 * Les dépendances directes (dependencies, optionalDependencies, peerDependencies ; `devDependencies` si `includeDev`)
 * de chaque package.json, comparées à la liste permise `allowed` ({ nom: raison } ou liste de noms). `ignore` écarte
 * des noms (les paquets du dépôt lui-même, par exemple /^@astratra\//).
 */
function checkDependencyAllowlist({ packageJsons, allowed, includeDev = false, ignore = [] }) {
  const permitted = new Set(Array.isArray(allowed) ? allowed : Object.keys(allowed || {}));
  const files = typeof packageJsons === 'string' ? [packageJsons] : packageJsons;
  const unexpected = [];
  const used = new Set();
  for (const file of files) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fields = ['dependencies', 'optionalDependencies', 'peerDependencies', ...(includeDev ? ['devDependencies'] : [])];
    for (const field of fields) {
      for (const name of Object.keys(manifest[field] || {})) {
        if (ignore.some((rule) => (rule instanceof RegExp ? rule.test(name) : rule === name))) continue;
        used.add(name);
        if (!permitted.has(name)) unexpected.push({ name, file: path.relative(process.cwd(), file), field });
      }
    }
  }
  const unused = [...permitted].filter((name) => !used.has(name));
  return { passed: unexpected.length === 0, unexpected, unused };
}

function assertDependencyAllowlist(options) {
  const report = checkDependencyAllowlist(options);
  if (!report.passed) {
    throw new AssertionError({ message: `${report.unexpected.length} dependency(ies) not in the allowed list:\n${report.unexpected.map((u) => `  - ${u.name} (${u.field} of ${u.file})`).join('\n')}\nAdd it to the allowed list only after deciding it is needed.` });
  }
  return report;
}

module.exports = { checkLockfile, assertLockfile, checkDependencyAllowlist, assertDependencyAllowlist };
