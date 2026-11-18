// Des noms seuls et des « ...require() » dans l'objet exporté : Node les lit sans exécuter le fichier, pour les
// imports nommés d'un module ES (import { createLogger } from '@astratra/core'). Une valeur écrite require('./x')
// arrêtait cette lecture dès la première ligne : seul apiResponse restait visible en module ES.
const apiResponse = require('./apiResponse');
const asyncHandler = require('./asyncHandler');
const createLogger = require('./logger');
const AppError = require('./AppError');
const errorMiddleware = require('./errorMiddleware');
const notFoundMiddleware = require('./notFoundMiddleware');
const requestIdMiddleware = require('./requestIdMiddleware');
const validateMiddleware = require('./validateMiddleware');
const loadEnv = require('./loadEnv');

module.exports = {
  apiResponse,
  asyncHandler,
  createLogger,
  AppError,
  errorMiddleware,
  notFoundMiddleware,
  requestIdMiddleware,
  validateMiddleware,
  loadEnv,
  ...require('./idempotency'),
  ...require('./googleServiceAccount')
};
