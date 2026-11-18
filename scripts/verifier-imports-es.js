#!/usr/bin/env node
'use strict';

/**
 * Les imports nommés depuis un module ES (import { createLogger } from '@astratra/core'), vérifiés à chaque
 * `npm run lint` : Node devine les noms d'un paquet CommonJS en lisant son fichier sans l'exécuter, et une seule valeur
 * écrite comme une expression dans l'objet exporté (require('./x'), module.prop, un objet en ligne) arrête cette
 * lecture. Les exports suivants disparaissent alors pour tout projet en module ES (un serveur produit par Humalis l'est).
 * Ici, chaque nom que require() donne doit aussi être un import nommé.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// native-ui est du code React Native (JSX), lu par le bundler de l'application, jamais chargé par Node.
const IGNORED = new Map([['native-ui', 'React Native, jamais chargé par Node']]);

const root = path.resolve(__dirname, '..', 'packages');
let failed = false;
let checked = 0;
for (const name of fs.readdirSync(root).sort()) {
  const manifestFile = path.join(root, name, 'package.json');
  if (!fs.existsSync(manifestFile) || IGNORED.has(name)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.type === 'module' || !manifest.main) continue;
  // L'entrée principale, et les entrées publiées à côté (un fichier .js à la racine du paquet, comme
  // @astratra/testkit/security).
  const entries = [manifest.main, ...(manifest.files || []).filter((f) => /^[\w.-]+\.c?js$/.test(f) && f !== 'jest-preset.js')];
  for (const relative of [...new Set(entries)]) {
    const entry = path.join(root, name, relative);
    if (!fs.existsSync(entry)) continue;
    const names = Object.keys(require(entry)).sort();
    const script = `import * as m from ${JSON.stringify(pathToFileURL(entry).href)}; process.stdout.write(JSON.stringify(Object.keys(m)))`;
    const visible = new Set(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })));
    const missing = names.filter((n) => !visible.has(n));
    checked += 1;
    if (missing.length) {
      failed = true;
      console.error(`${manifest.name}${relative === manifest.main ? '' : ` (${relative})`} : ${missing.length} export(s) invisibles en module ES (${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}).`);
    }
  }
}
if (failed) {
  console.error('Écrire l’objet exporté avec des noms seuls (nom, nom: autreNom) et des ...require(\'./x\') ; préparer les autres valeurs dans des const avant.');
  process.exit(1);
}
console.log(`Imports nommés en module ES : ${checked} entrées vérifiées.`);
