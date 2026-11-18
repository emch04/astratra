#!/usr/bin/env node
'use strict';

/**
 * La chaîne d'approvisionnement du dépôt, vérifiée à chaque `npm run lint` :
 *   - chaque dépendance externe des paquets est dans allowed-dependencies.json, avec sa raison ;
 *   - le verrou ne tire que du registre npm officiel, en https, chaque paquet avec son empreinte sha512 ;
 *   - aucun paquet nouveau ne lance de script à l'installation.
 */
const fs = require('node:fs');
const path = require('node:path');
const { checkDependencyAllowlist, checkLockfile } = require('@astratra/testkit/security');

const root = path.resolve(__dirname, '..');
const allowed = JSON.parse(fs.readFileSync(path.join(root, 'allowed-dependencies.json'), 'utf8'));
const manifests = fs
  .readdirSync(path.join(root, 'packages'))
  .map((name) => path.join(root, 'packages', name, 'package.json'))
  .filter((file) => fs.existsSync(file));

let failed = false;
const deps = checkDependencyAllowlist({ packageJsons: manifests, allowed: allowed.dependencies, ignore: [/^@astratra\//] });
if (!deps.passed) {
  failed = true;
  console.error(`Dépendances non décidées (ajoutez-les à allowed-dependencies.json avec leur raison, seulement si elles sont nécessaires) :`);
  for (const u of deps.unexpected) console.error(`  - ${u.name} (${u.field} de ${path.relative(root, u.file)})`);
}
if (deps.unused.length) {
  failed = true;
  console.error(`Dépendances permises que plus aucun paquet n'utilise (à retirer de allowed-dependencies.json) : ${deps.unused.join(', ')}`);
}
const lock = checkLockfile(path.join(root, 'package-lock.json'), { allowInstallScripts: allowed.installScripts });
if (!lock.passed) {
  failed = true;
  console.error('Verrou npm :');
  for (const p of lock.problems) console.error(`  - ${p.name} : ${p.problem}`);
}
if (failed) process.exit(1);
console.log(`Chaîne d'approvisionnement : ${Object.keys(allowed.dependencies).length} dépendances décidées, ${lock.packages} paquets du verrou vérifiés.`);
