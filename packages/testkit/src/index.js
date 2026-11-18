'use strict';

const { createFakeData, supportedCountries, EMAIL_DOMAIN } = require('./data');

// Des noms seuls et des « ...require() » dans l'objet exporté : Node les lit sans exécuter le fichier, pour les
// imports nommés d'un module ES.
module.exports = { ...require('./agentEvaluation'), ...require('./guard'), ...require('./containers'), createFakeData, supportedCountries, EMAIL_DOMAIN };
