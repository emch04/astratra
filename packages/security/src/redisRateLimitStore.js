const crypto = require('node:crypto');
const { createLogger } = require('@astratra/core');
const { createMemoryRateLimitStore } = require('./rateLimit');

const logger = createLogger('rate-limit-redis');

/*
 * Le magasin Redis du limiteur, sans rate-limit-redis :
 *   - le compteur et son expiration s'écrivent en une seule opération (script Lua) : une panne entre les deux ne laisse
 *     jamais un compteur sans fin ;
 *   - les clés sont hachées (SHA-256) : ni adresse ni e-mail en clair dans Redis, et une clé immense envoyée par un
 *     client ne fait pas une clé immense dans Redis ;
 *   - tant que Redis n'est pas joignable (au démarrage, ou s'il tombe), le compte se fait en mémoire : la limite reste
 *     appliquée, par serveur, au lieu de laisser passer ou de faire échouer chaque requête.
 */
const INCREMENT = `local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}`;
const DECREMENT = `local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;
const READ = `local n = redis.call('GET', KEYS[1])
if not n then return nil end
return {tonumber(n), redis.call('PTTL', KEYS[1])}`;

/**
 * `redisUrl` : le magasin ouvre sa propre connexion (paquet `redis`, à installer par le projet). Ou `sendCommand(args)` /
 * `client` : une connexion du projet (node-redis : client.sendCommand ; ioredis : (args) => client.call(...args)).
 * `prefix` : l'espace des clés, choisi par le projet (« rl: » par défaut).
 * `commandTimeoutMs` : au-delà, une commande compte comme une panne (un Redis figé garde la connexion ouverte sans
 * répondre : sans ce délai, la requête attendait sans fin). `retryAfterMs` : après une panne, le compte se fait en
 * mémoire pendant ce temps avant de réessayer Redis, pour que chaque requête n'attende pas le délai.
 */
function createRedisRateLimitStore({ redisUrl, prefix = 'rl:', sendCommand, client, hashKeys = true, commandTimeoutMs = 1000, retryAfterMs = 2000 } = {}) {
  let send = sendCommand || (client && typeof client.sendCommand === 'function' ? (args) => client.sendCommand(args) : null);
  let ownClient = null;
  let ready = Boolean(send);
  if (!send) {
    if (!redisUrl) return undefined;
    let RedisModule;
    try {
      RedisModule = require('redis');
    } catch {
      return undefined;
    }
    if (!RedisModule || typeof RedisModule.createClient !== 'function') return undefined;
    // Sans file d'attente hors connexion : une commande envoyée pendant une coupure échoue tout de suite (et le compte
    // passe en mémoire) au lieu d'attendre, requête suspendue, que Redis revienne.
    ownClient = RedisModule.createClient({
      url: redisUrl,
      disableOfflineQueue: true,
      socket: { connectTimeout: 3000, reconnectStrategy: (retries) => Math.min(200 * (retries + 1), 5000) },
    });
    if (typeof ownClient.on === 'function') {
      ownClient.on('error', () => {});
      ownClient.on('ready', () => {
        ready = true;
      });
      ownClient.on('end', () => {
        ready = false;
      });
    }
    send = (args) => ownClient.sendCommand(args);
    Promise.resolve()
      .then(() => ownClient.connect())
      .then(() => {
        ready = true;
      })
      .catch(() => {
        ready = false;
      });
  }

  const memory = createMemoryRateLimitStore();
  let windowMs = 60_000;
  let warned = false;
  const redisKey = (key) => prefix + (hashKeys ? crypto.createHash('sha256').update(String(key)).digest('hex') : String(key));
  let downUntil = 0;
  const withTimeout = (promise) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis command timed out')), commandTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const viaRedis = async (operation, fallback) => {
    if (!ready || Date.now() < downUntil) return fallback();
    try {
      const result = await withTimeout(Promise.resolve().then(operation));
      warned = false;
      return result;
    } catch {
      downUntil = Date.now() + retryAfterMs;
      if (!warned) {
        warned = true;
        logger.warn('Redis ne répond pas : les limites de requêtes se comptent en mémoire de ce serveur jusqu’à son retour.');
      }
      return fallback();
    }
  };

  return {
    localKeys: false,
    prefix,
    init(options = {}) {
      if (Number.isFinite(options.windowMs) && options.windowMs > 0) windowMs = options.windowMs;
      memory.init({ windowMs });
    },
    increment(key) {
      return viaRedis(async () => {
        const reply = await send(['EVAL', INCREMENT, '1', redisKey(key), String(windowMs)]);
        const totalHits = Number(reply[0]);
        const ttl = Number(reply[1]);
        if (!Number.isFinite(totalHits)) throw new Error('unexpected Redis reply');
        return { totalHits, resetTime: new Date(Date.now() + (ttl > 0 ? ttl : windowMs)) };
      }, () => memory.increment(key));
    },
    decrement(key) {
      return viaRedis(async () => {
        await send(['EVAL', DECREMENT, '1', redisKey(key)]);
      }, () => memory.decrement(key));
    },
    resetKey(key) {
      // Effacé des deux côtés : un compte fait en mémoire pendant une coupure ne survit pas à une remise à zéro.
      return Promise.all([viaRedis(() => send(['DEL', redisKey(key)]), () => undefined), memory.resetKey(key)]).then(() => undefined);
    },
    get(key) {
      return viaRedis(async () => {
        const reply = await send(['EVAL', READ, '1', redisKey(key)]);
        if (!reply) return undefined;
        return { totalHits: Number(reply[0]), resetTime: new Date(Date.now() + Math.max(Number(reply[1]), 0)) };
      }, () => memory.get(key));
    },
    async resetAll() {
      await memory.resetAll();
    },
    shutdown() {
      memory.shutdown();
      if (ownClient) {
        ready = false;
        Promise.resolve()
          .then(() => (ownClient.isOpen ? ownClient.quit() : undefined))
          .catch(() => {});
      }
    },
  };
}

module.exports = { createRedisRateLimitStore, REDIS_INCREMENT_SCRIPT: INCREMENT };
