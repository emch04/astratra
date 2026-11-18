const net = require('node:net');

/**
 * Le limiteur de requêtes, écrit ici sans dépendance (il remplace express-rate-limit et rate-limit-redis) :
 * une fenêtre fixe par clé, un magasin interchangeable (mémoire, Redis, ou celui du projet), les en-têtes
 * RateLimit-* et la réponse 429. Les options et l'interface des magasins sont celles qu'utilisaient déjà les
 * projets (init, increment, decrement, resetKey, get, resetAll, shutdown), pour qu'aucun n'ait à changer.
 */

const DEFAULT_IPV6_SUBNET = 56;

/** Les huit groupes de 16 bits d'une adresse IPv6, ou null. Accepte « :: », la fin en IPv4 et un identifiant de zone. */
function ipv6Groups(address) {
  let text = String(address).split('%')[0];
  if (!net.isIPv6(text)) return null;
  // Une fin en IPv4 (::ffff:1.2.3.4) devient deux groupes. Découpée sans expression régulière : une expression non
  // ancrée sur une longue suite de chiffres s'emballait (trouvé par assertSafeRegex de @astratra/testkit/security).
  const tail = text.slice(text.lastIndexOf(':') + 1);
  if (net.isIPv4(tail)) {
    const parts = tail.split('.').map(Number);
    text = text.slice(0, -tail.length) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(rest !== undefined ? missing : 0).fill('0'), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** L'écriture courte (RFC 5952) : minuscules, sans zéros de tête, la plus longue suite de zéros remplacée par « :: ». */
function formatIpv6(groups) {
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/**
 * La clé d'une adresse : une adresse IPv4 telle quelle (même écrite en IPv6, « ::ffff:1.2.3.4 ») ; une adresse IPv6
 * compte pour tout son bloc (/56 par défaut), sinon chacun change d'adresse dans son bloc et repart avec un compteur
 * neuf. `subnet` à false garde l'adresse exacte.
 */
function ipKey(address, subnet = DEFAULT_IPV6_SUBNET) {
  const ip = String(address || '');
  if (!ip || net.isIPv4(ip)) return ip;
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  // IPv4 écrite en IPv6 (::ffff:a.b.c.d) : c'est l'adresse IPv4 qui compte.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  if (!subnet) return formatIpv6(groups);
  const masked = groups.map((g, i) => {
    const bitsBefore = i * 16;
    if (bitsBefore >= subnet) return 0;
    if (bitsBefore + 16 <= subnet) return g;
    return g & (0xffff << (16 - (subnet - bitsBefore))) & 0xffff;
  });
  return `${formatIpv6(masked)}/${subnet}`;
}

const requestIp = (req) => (req && (req.ip || (req.connection && req.connection.remoteAddress) || (req.socket && req.socket.remoteAddress))) || '';

/**
 * Le magasin en mémoire : une fenêtre fixe par clé. Les clés expirées sont retirées à chaque fenêtre (minuterie qui
 * ne retient pas le processus) et quand la table dépasse `maxKeys` : un afflux de clés neuves ne fait pas grossir la
 * mémoire sans fin.
 */
function createMemoryRateLimitStore({ maxKeys = 100_000 } = {}) {
  const counters = new Map();
  let windowMs = 60_000;
  let timer = null;
  const sweep = (now = Date.now()) => {
    for (const [key, counter] of counters) if (counter.resetAt <= now) counters.delete(key);
  };
  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(sweep, windowMs);
    if (typeof timer.unref === 'function') timer.unref();
  };
  return {
    localKeys: true,
    init(options = {}) {
      if (Number.isFinite(options.windowMs) && options.windowMs > 0) windowMs = options.windowMs;
      schedule();
    },
    async get(key) {
      const counter = counters.get(key);
      if (!counter || counter.resetAt <= Date.now()) return undefined;
      return { totalHits: counter.hits, resetTime: new Date(counter.resetAt) };
    },
    async increment(key) {
      const now = Date.now();
      let counter = counters.get(key);
      if (!counter || counter.resetAt <= now) {
        if (!counter && counters.size >= maxKeys) sweep(now);
        counter = { hits: 0, resetAt: now + windowMs };
        counters.set(key, counter);
      }
      counter.hits += 1;
      return { totalHits: counter.hits, resetTime: new Date(counter.resetAt) };
    },
    async decrement(key) {
      const counter = counters.get(key);
      if (counter && counter.hits > 0) counter.hits -= 1;
    },
    async resetKey(key) {
      counters.delete(key);
    },
    async resetAll() {
      counters.clear();
    },
    shutdown() {
      if (timer) clearInterval(timer);
      timer = null;
      counters.clear();
    },
  };
}

const defaultHandler = (req, res, _next, options) => {
  res.status(options.statusCode);
  const message = options.message;
  if (message !== null && typeof message === 'object') return res.json(message);
  if (typeof res.send === 'function') return res.send(message);
  return res.json(message);
};

/**
 * Le middleware. Options (celles qu'acceptait express-rate-limit, sauf `validate`, sans objet ici) :
 *   windowMs, limit ou max (nombre, ou fonction (req, res) qui rend un nombre), keyGenerator (req, res), skip (req, res),
 *   message (valeur ou fonction (req, res)), statusCode, handler (req, res, next, options), standardHeaders,
 *   legacyHeaders, store, passOnStoreError, requestPropertyName, skipSuccessfulRequests, skipFailedRequests,
 *   requestWasSuccessful (req, res), ipv6Subnet.
 */
function createRateLimit(options = {}) {
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : 60_000;
  const limitOption = options.limit !== undefined ? options.limit : options.max !== undefined ? options.max : 5;
  const statusCode = options.statusCode || 429;
  const standardHeaders = options.standardHeaders === undefined ? true : options.standardHeaders;
  const legacyHeaders = Boolean(options.legacyHeaders);
  const requestPropertyName = options.requestPropertyName || 'rateLimit';
  const ipv6Subnet = options.ipv6Subnet === undefined ? DEFAULT_IPV6_SUBNET : options.ipv6Subnet;
  const keyGenerator = options.keyGenerator || ((req) => ipKey(requestIp(req), ipv6Subnet));
  const handler = options.handler || defaultHandler;
  const requestWasSuccessful = options.requestWasSuccessful || ((_req, res) => res.statusCode < 400);
  const store = options.store || createMemoryRateLimitStore();
  if (typeof store.increment !== 'function') throw new TypeError('createRateLimit: the store needs an increment(key) method.');
  if (typeof store.init === 'function') store.init({ windowMs });

  const middleware = async function rateLimitMiddleware(req, res, next) {
    try {
      if (options.skip && (await options.skip(req, res))) return next();
      const key = String(await keyGenerator(req, res));
      let counted;
      try {
        counted = await store.increment(key);
      } catch (storeError) {
        // Un magasin en panne ne laisse jamais passer sans compter, sauf choix explicite du projet.
        if (options.passOnStoreError) return next();
        return next(storeError);
      }
      const totalHits = Number(counted && counted.totalHits);
      if (!Number.isFinite(totalHits)) return next(new Error('rate limit store returned no hit count'));
      const resetTime = counted.resetTime instanceof Date ? counted.resetTime : new Date(Date.now() + windowMs);
      const limit = Number(typeof limitOption === 'function' ? await limitOption(req, res) : limitOption);
      const remaining = Math.max(limit - totalHits, 0);
      if (req && typeof req === 'object') req[requestPropertyName] = { limit, used: totalHits, remaining, resetTime, key };

      const secondsLeft = Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
      if (!res.headersSent && typeof res.setHeader === 'function') {
        if (standardHeaders) {
          res.setHeader('RateLimit-Policy', `${limit};w=${Math.ceil(windowMs / 1000)}`);
          res.setHeader('RateLimit-Limit', String(limit));
          res.setHeader('RateLimit-Remaining', String(remaining));
          res.setHeader('RateLimit-Reset', String(secondsLeft));
        }
        if (legacyHeaders) {
          res.setHeader('X-RateLimit-Limit', String(limit));
          res.setHeader('X-RateLimit-Remaining', String(remaining));
          res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetTime.getTime() / 1000)));
        }
      }

      if ((options.skipSuccessfulRequests || options.skipFailedRequests) && typeof res.on === 'function') {
        let settled = false;
        const settle = async (closedEarly) => {
          if (settled) return;
          settled = true;
          const success = !closedEarly && requestWasSuccessful(req, res);
          if ((success && options.skipSuccessfulRequests) || (!success && options.skipFailedRequests)) {
            try {
              if (typeof store.decrement === 'function') await store.decrement(key);
            } catch {
              // Un décompte manqué ne fait que garder la requête comptée : jamais plus permissif.
            }
          }
        };
        res.on('finish', () => settle(false));
        res.on('close', () => settle(!res.writableFinished));
      }

      if (totalHits > limit) {
        if (!res.headersSent && typeof res.setHeader === 'function' && (standardHeaders || legacyHeaders)) res.setHeader('Retry-After', String(secondsLeft));
        const message = typeof options.message === 'function' ? await options.message(req, res) : options.message;
        return handler(req, res, next, { ...options, windowMs, limit, statusCode, message: message === undefined ? 'Too many requests, please try again later.' : message });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };

  middleware.resetKey = (key) => (typeof store.resetKey === 'function' ? store.resetKey(String(key)) : undefined);
  middleware.getKey = (key) => (typeof store.get === 'function' ? store.get(String(key)) : undefined);
  middleware.store = store;
  return middleware;
}

module.exports = { createRateLimit, createMemoryRateLimitStore, ipKey, requestIp, DEFAULT_IPV6_SUBNET };
