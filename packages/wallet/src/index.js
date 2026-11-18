const { createApplePasses, sendApplePassUpdate, notifyApplePass } = require('./apple');
const { createAppleWebServiceRouter } = require('./appleWebService');
const { createGoogleWallet, signSaveJwt } = require('./google');
const { createMemoryRegistrationStore, createMongooseRegistrationStore } = require('./registrations');

// Des noms seuls et des « ...require() » dans l'objet exporté : Node les lit sans exécuter le fichier, pour les
// imports nommés d'un module ES.
module.exports = {
  ...require('./credentials'),
  createApplePasses,
  sendApplePassUpdate,
  notifyApplePass,
  createAppleWebServiceRouter,
  createGoogleWallet,
  signSaveJwt,
  createMemoryRegistrationStore,
  createMongooseRegistrationStore
};
