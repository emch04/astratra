const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Un projet en module ES importe ce paquet par noms (import { createAuthMiddleware } from '@astratra/security') :
// Node devine ces noms en lisant src/index.js sans l'exécuter. Une seule propriété écrite comme une expression dans
// l'objet exporté arrêtait cette lecture, et tous les exports suivants disparaissaient pour les modules ES (le serveur
// produit par Humalis ne démarrait plus). Chaque export de require() doit donc aussi être un import nommé.
test('chaque export est aussi un import nommé depuis un module ES', () => {
  const entry = path.resolve(__dirname, '../src/index.js');
  const names = Object.keys(require('../src')).sort();
  const script = `import * as m from ${JSON.stringify(require('node:url').pathToFileURL(entry).href)}; console.log(JSON.stringify(Object.keys(m).filter((k) => k !== 'default' && k !== 'module.exports').sort()));`;
  const esm = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  expect(esm).toEqual(names);
});
