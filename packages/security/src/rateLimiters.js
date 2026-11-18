const { createLogger } = require('@astratra/core');
const { bodyLeftUnparsed } = require('./requestBody');
const { createRateLimit, createMemoryRateLimitStore, ipKey, requestIp } = require('./rateLimit');

// Exportés sous ce nom : la clé d'une adresse pour un limiteur écrit par le projet.
const rateLimitKeyForIp = ipKey;
const { createRedisRateLimitStore: createRedisStoreWithOptions } = require('./redisRateLimitStore');

const logger = createLogger('rate-limiters');

const DEFAULT_API_MESSAGE = {
  success: false,
  message: 'Too many requests.'
};

const DEFAULT_LOGIN_MESSAGE = {
  success: false,
  message: 'Too many login attempts. Please try again later.'
};

const DEFAULT_ACCOUNT_MESSAGE = {
  success: false,
  message: 'Too many attempts for this account. Please try again later.'
};

const getIp = requestIp;

// Une adresse IPv6 compte pour tout son bloc /56 : sinon chacun change d'adresse
// dans son bloc et repart avec un compteur neuf. IPv4 reste l'adresse exacte.
const clientKey = (req) => ipKey(getIp(req));

const skipLocalhost = (req) => {
  const ip = getIp(req);
  return ip === '::1' || ip === '127.0.0.1' || ip.includes('localhost');
};

const sendLimitResponse = async (req, res, next, options, onBlocked, context) => {
  if (onBlocked) {
    await onBlocked(context);
  }

  return res.status(options.statusCode).json(options.message);
};

// Store Redis générique : le namespace est choisi par le projet consommateur.
// Astratra ne connaît donc aucun domaine métier (auth, commandes, réservations…).
const createRedisRateLimitStore = (options = {}) => createRedisStoreWithOptions(options);

/* Avec redisUrl seul, chaque sorte de limiteur a son espace de clés : sous un même préfixe, la clé (l'adresse) était
   la même pour la limite de l'API et pour celle de la connexion. Les requêtes ordinaires remplissaient alors le
   compteur de la connexion (10 par défaut), et la personne ne pouvait plus se connecter. */
const resolveStore = (options, kind) => {
  if (options.store) return options.store;
  return createRedisStoreWithOptions({ redisUrl: options.redisUrl, prefix: `rl:${kind}:` });
};

const withOptionalStore = (limiterOptions, store) => {
  if (!store) return limiterOptions;
  return { ...limiterOptions, store };
};

const defaultApiSkip = () => (process.env.NODE_ENV === 'production' ? undefined : skipLocalhost);

/**
 * `area(req)` sépare les compteurs : chaque zone rendue (`{ name, max }`) a le
 * sien, par adresse. Avec un seul compteur, une boucle ou un gros téléchargement
 * sur une page rendait toutes les autres indisponibles. L'application donne une
 * liste fermée de noms : un nom tiré librement de l'adresse demandée offrirait
 * un compteur neuf à chaque requête, donc plus aucune limite.
 */
const createApiLimiter = (options = {}) => {
  const fallback = options.max || 300;
  const { area } = options;
  return createRateLimit(withOptionalStore({
    windowMs: options.windowMs || 15 * 60 * 1000,
    max: area ? (req) => area(req)?.max || fallback : fallback,
    ...(area ? { keyGenerator: (req) => `${area(req)?.name || 'default'}:${clientKey(req)}` } : {}),
    skip: options.skip ?? defaultApiSkip(),
    standardHeaders: options.standardHeaders ?? true,
    legacyHeaders: options.legacyHeaders ?? false,
    message: options.message || DEFAULT_API_MESSAGE
  }, resolveStore(options, 'api')));
};

const createLoginLimiter = (options = {}) => createRateLimit(withOptionalStore({
  windowMs: options.windowMs || 15 * 60 * 1000,
  max: options.max || 10,
  skip: options.skip,
  standardHeaders: options.standardHeaders ?? true,
  legacyHeaders: options.legacyHeaders ?? false,
  message: options.message || DEFAULT_LOGIN_MESSAGE,
  handler: (req, res, next, limitOptions) => sendLimitResponse(
    req,
    res,
    next,
    limitOptions,
    options.onBlocked,
    { ip: getIp(req), req }
  )
}, resolveStore(options, 'login')));

// Avertit une seule fois par processus (fonction partagée par toute instance
// de createAccountLimiter utilisant la clé par défaut) : le problème est un
// ordre de montage figé au démarrage, pas quelque chose qui varie requête par
// requête.
let warnedUnparsedBody = false;

const defaultAccountKeyGenerator = (req) => {
  // Même défaut de conception que le WAF (voir waf.js) : req.body est
  // `undefined` si createAccountLimiter() est monté avant express.json().
  // Sans cette détection, toute tentative de connexion retombait alors sur la
  // clé partagée "unknown" — plus de limite PAR COMPTE, une seule limite
  // globale pour tous les comptes confondus. Deux effets, tous deux mauvais :
  // un attaquant peut essayer des mots de passe sur des comptes DIFFÉRENTS
  // sans jamais être freiné par compte, et des utilisateurs légitimes sans
  // rapport entre eux peuvent se faire bloquer les uns par les autres.
  if (bodyLeftUnparsed(req) && !warnedUnparsedBody) {
    warnedUnparsedBody = true;
    logger.warn(
      'req.body est undefined dans createAccountLimiter() — à monter APRÈS ' +
      "express.json()/express.urlencoded(), sinon toutes les tentatives sont " +
      'regroupées sous la même clé "unknown" au lieu d\'être limitées par compte.'
    );
  }

  const body = req.body || {};
  const identifier = body.email || body.identifier || 'unknown';
  return String(identifier).toLowerCase();
};

const createAccountLimiter = (options = {}) => {
  const keyGenerator = options.keyGenerator || defaultAccountKeyGenerator;

  return createRateLimit(withOptionalStore({
    windowMs: options.windowMs || 30 * 60 * 1000,
    max: options.max || 20,
    skip: options.skip,
    standardHeaders: options.standardHeaders ?? true,
    legacyHeaders: options.legacyHeaders ?? false,
    keyGenerator,
    message: options.message || DEFAULT_ACCOUNT_MESSAGE,
    handler: (req, res, next, limitOptions) => {
      const body = req.body || {};
      const identifier = body.email || body.identifier || 'unknown';
      return sendLimitResponse(
        req,
        res,
        next,
        limitOptions,
        options.onBlocked,
        { identifier, ip: getIp(req), req }
      );
    }
  }, resolveStore(options, 'account')));
};

// Des noms seuls dans cet objet (pas d'expression) : Node lit ces exports sans exécuter le fichier pour les imports
// nommés d'un module ES (import { createRateLimit } from '@astratra/security').
module.exports = {
  createRateLimit,
  createMemoryRateLimitStore,
  rateLimitKeyForIp,
  createRedisRateLimitStore,
  createApiLimiter,
  createLoginLimiter,
  createAccountLimiter,
  skipLocalhost
};
