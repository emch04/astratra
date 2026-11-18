'use strict';

/**
 * `@astratra/testkit/security` : les essais de sécurité, sans aucune dépendance (Node seul), utilisables avec
 * `node:test` comme avec Jest (les échecs sont des AssertionError de node:assert).
 */
module.exports = {
  ...require('./random'),
  ...require('./payloads'),
  ...require('./jwt'),
  ...require('./generators'),
  ...require('./properties'),
  ...require('./fuzz'),
  ...require('./redos'),
  ...require('./resources'),
  ...require('./differential'),
  ...require('./vectors'),
  ...require('./metamorphic'),
  ...require('./timing'),
  ...require('./logs'),
  ...require('./access'),
  ...require('./races'),
  ...require('./faults'),
  ...require('./mutation'),
  ...require('./supplyChain'),
  ...require('./describe'),
};
