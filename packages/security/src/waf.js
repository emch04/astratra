const { createLogger } = require('@astratra/core');
const { bodyLeftUnparsed } = require('./requestBody');

const logger = createLogger('waf');

const WAF_PATTERNS = [
  /(\b(union|select|insert|update|delete|drop|alter|create)\b.*\b(from|into|table|database)\b)/gi,
  /(\b(or|and)\b\s+\d+\s*=\s*\d+)/gi,
  /(--|#|\/\*|\*\/|;--)/g,
  /(\.\.\/(\.\.\/){2,})/g,
  /(\/etc\/passwd|\/proc\/self|\/dev\/null)/gi,
  /(<script[\s>]|javascript:|on(error|load|click|mouseover)\s*=)/gi,
  /(\$\{.*\}|\$\(.*\))/g,
  /(\bexec\b|\beval\b|\bFunction\b)\s*\(/gi
];

const DEFAULT_MESSAGE = {
  success: false,
  message: 'Request blocked by security policy.'
};

const safeStringify = (value) => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value || {});
  } catch (_error) {
    return '';
  }
};

const createWafMiddleware = (options = {}) => {
  const message = options.message || DEFAULT_MESSAGE;
  const patterns = options.patterns || WAF_PATTERNS;
  // Avertit une seule fois par instance de middleware, pas à chaque requête :
  // le problème (mauvais ordre au montage) ne change pas d'une requête à
  // l'autre, et logguer en boucle sous charge serait juste du bruit.
  let warnedUnparsedBody = false;

  return (req, res, next) => {
    // Un corps envoyé mais laissé à `undefined` signifie qu'aucun body-parser
    // (express.json, express.urlencoded...) n'a tourné avant ce middleware.
    // Express 5 laisse aussi req.body à `undefined` quand la requête n'a pas
    // de corps : seul un corps annoncé (voir requestBody.js) compte. Sans cette détection, ce middleware inspectait silencieusement
    // une chaîne vide à la place du corps de la requête : aucune erreur,
    // aucun log, juste une protection qui ne protégeait rien.
    if (bodyLeftUnparsed(req) && !warnedUnparsedBody) {
      warnedUnparsedBody = true;
      logger.warn(
        'req.body est undefined — createWafMiddleware() doit être monté APRÈS ' +
        'express.json()/express.urlencoded(), sinon le corps des requêtes ' +
        "n'est jamais inspecté (SQLi/XSS dans le body passeraient sans être bloqués)."
      );
    }

    const targets = [
      req.path,
      safeStringify(req.query),
      safeStringify(req.body)
    ].join(' ');

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(targets)) {
        return res.status(403).json(message);
      }
    }

    return next();
  };
};

module.exports = {
  createWafMiddleware,
  WAF_PATTERNS
};
