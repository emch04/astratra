const { createEndpointBreaker, ModelsCircuitOpenError } = require('./breaker');
const manifest = require('./manifest');
const fetcher = require('./fetcher');
const ready = require('./ready');

// Des noms seuls et des « ...require() » dans l'objet exporté : Node les lit sans exécuter le fichier, pour les
// imports nommés d'un module ES.
const { loadManifest, manifestProblems, MANIFEST_PATH } = manifest;
const listModelFiles = manifest.listFiles;
const { fetchModels, checkModels, ManifestIncompleteError, ChecksumError } = fetcher;
const { assertModelsReady, ModelsNotReadyError } = ready;

module.exports = {
  ...require('./client'),
  createEndpointBreaker,
  ModelsCircuitOpenError,
  ...require('./deploy'),
  ...require('./pricing'),
  loadManifest,
  manifestProblems,
  listModelFiles,
  MANIFEST_PATH,
  fetchModels,
  checkModels,
  ManifestIncompleteError,
  ChecksumError,
  assertModelsReady,
  ModelsNotReadyError
};
