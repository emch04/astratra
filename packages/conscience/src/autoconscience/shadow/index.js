'use strict';
/* P4 · shadow mode (21 shadow mode, 32 sandbox of the shadow mode). */
const runner = require('./runner');
const store = require('./store');
const report = require('./report');

// Des noms seuls dans l'objet exporté : Node les lit sans exécuter le fichier, pour les imports nommés d'un module ES.
const { createShadowRunner } = runner;
const SHADOW_CONCLUSIONS = report.CONCLUSIONS;
const { createMemoryShadowStore, createPostgresShadowStore, postgresShadowSchema, shadowEraser } = store;
module.exports = {
  createShadowRunner, SHADOW_CONCLUSIONS,
  createMemoryShadowStore, createPostgresShadowStore,
  postgresShadowSchema, shadowEraser
};
