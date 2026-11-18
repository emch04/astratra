'use strict';
const model = require('./model');
// Des noms seuls dans l'objet exporté : Node les lit sans exécuter le fichier, pour les imports nommés d'un module ES.
const { RATINGS, FEEDBACK_REASONS, FeedbackError, scrubPersonalData } = model;
const { createMemoryFeedbackStore } = require('./stores');
module.exports = {
  RATINGS, FEEDBACK_REASONS, FeedbackError, scrubPersonalData,
  createMemoryFeedbackStore,
  ...require('./postgres'), ...require('./service'), ...require('./router')
};
