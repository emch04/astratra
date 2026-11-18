'use strict';
/* P3, second half: vigilance (17 drift, 18 follow-ups, 26 abstention, 27 night adversary, 14 multi-role review, 03 lesson turned into a test). */
const drift = require('./drift');
const followups = require('./followups');
const abstention = require('./abstention');
const adversary = require('./adversary');
const roles = require('./roles');
const lessonTests = require('./lessonTests');
const library = require('./library');
const store = require('./store');

// Des noms seuls dans l'objet exporté : Node les lit sans exécuter le fichier, pour les imports nommés d'un module ES.
const { detectDrift, snapshotWindow, populationStabilityIndex, differenceInterval, DRIFT_RECOMMENDATIONS } = drift;
const { createFollowUps, followUpEraser, FOLLOW_UP_STATUSES } = followups;
const { abstentionPolicy, shouldAbstain, ABSTENTION_DEFAULT_THRESHOLD } = abstention;
const { generateAdversarialCases, ADVERSARIAL_CATEGORIES } = adversary;
const { reviewByRoles, REVIEW_ROLES, REVIEW_SCOPES } = roles;
const { lessonToScenario } = lessonTests;
const { createScenarioLibrary, SCENARIO_CATEGORIES, CANDIDATE_STATUSES } = library;
const scenarioToTestkit = library.toScenario;
const { createMemoryVigilanceStore, createPostgresVigilanceStore, postgresVigilanceSchema } = store;
module.exports = {
  detectDrift, snapshotWindow, populationStabilityIndex,
  differenceInterval, DRIFT_RECOMMENDATIONS,
  createFollowUps, followUpEraser, FOLLOW_UP_STATUSES,
  abstentionPolicy, shouldAbstain, ABSTENTION_DEFAULT_THRESHOLD,
  generateAdversarialCases, ADVERSARIAL_CATEGORIES,
  reviewByRoles, REVIEW_ROLES, REVIEW_SCOPES,
  lessonToScenario,
  createScenarioLibrary, scenarioToTestkit,
  SCENARIO_CATEGORIES, CANDIDATE_STATUSES,
  createMemoryVigilanceStore, createPostgresVigilanceStore, postgresVigilanceSchema
};
