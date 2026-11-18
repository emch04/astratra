'use strict';
/*
 * @astratra/conscience (P1): memory of an agent's decisions, outcomes,
 * corrections, lessons with evidence, and self-model, under a governor.
 */
const { createConscience, ERASURE_MODES } = require('./conscience');
const { createMemoryConscienceStore, matchesFilter } = require('./memoryStore');
const { postgresConscienceSchema, createPostgresConscienceStore } = require('./postgres');
const { frameStoredText, frameRecordsForModel } = require('./guard');
const { wordDelta } = require('./diff');
const { ConscienceError } = require('./errors');
const records = require('./records');
const { assertGovernorReady, isGovernor } = require('./governor/governor');
const { GovernorError } = require('./governor/util');

const { createMongoConscienceStore, mongoConscienceIndexes } = require('./mongo');

// Des noms seuls dans l'objet exporté : Node les lit sans exécuter le fichier, pour les imports nommés d'un module ES.
const { OUTCOME_STATUSES, CORRECTION_CLASSES, LESSON_STATUSES, EVIDENCE_DEGREES, EVIDENCE_KINDS, PROVENANCE_KINDS } = records;
const RECORD_KINDS = records.KINDS;

module.exports = {
  createMongoConscienceStore, mongoConscienceIndexes,
  createConscience, createMemoryConscienceStore, createPostgresConscienceStore, postgresConscienceSchema,
  frameStoredText, frameRecordsForModel, wordDelta, matchesFilter,
  ConscienceError, GovernorError, assertGovernorReady, isGovernor,
  RECORD_KINDS, OUTCOME_STATUSES, CORRECTION_CLASSES,
  LESSON_STATUSES, EVIDENCE_DEGREES, EVIDENCE_KINDS,
  PROVENANCE_KINDS, ERASURE_MODES
};
