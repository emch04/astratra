'use strict';

/**
 * Préréglage Jest pour les projets qui utilisent @astratra/testkit.
 *
 * `@faker-js/faker` 10 n'existe qu'en module ES. Node le charge par `require()`
 * (22.12 et plus), mais Jest a son propre chargeur : en CommonJS, il ne sait le
 * faire qu'à partir de Node 24.9 et avec `--experimental-vm-modules`. Ce
 * préréglage fait convertir faker en CommonJS par babel-jest (déjà fourni par
 * Jest), et lui seul parmi les `node_modules`. Le reste du projet garde la
 * transformation par défaut de Jest.
 *
 * Usage, dans la configuration Jest du projet : `preset: '@astratra/testkit'`.
 */
function commonjsPlugin() {
  try {
    return require.resolve('@babel/plugin-transform-modules-commonjs');
  } catch {
    // Depuis la 2.0.0, le module Babel n'est installé que par ceux qui utilisent ce préréglage.
    throw new Error('The @astratra/testkit Jest preset needs @babel/plugin-transform-modules-commonjs: npm install --save-dev @babel/plugin-transform-modules-commonjs');
  }
}

module.exports = {
  transform: {
    '\\.[jt]sx?$': ['babel-jest', { plugins: [commonjsPlugin()] }]
  },
  transformIgnorePatterns: ['/node_modules/(?!@faker-js/faker/)']
};
