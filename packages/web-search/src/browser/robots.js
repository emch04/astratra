/**
 * `robots.txt` (RFC 9309) pour le navigateur intégré.
 *
 * - Le groupe retenu est celui dont une ligne `User-agent` est le jeton de
 *   l'agent (`AstratraWebBrowser`, sans tenir compte de la casse) ; sinon le
 *   groupe `*` ; sinon tout est permis. Plusieurs groupes du même agent se
 *   cumulent.
 * - La règle qui correspond le plus longuement au chemin l'emporte ; à
 *   longueur égale, `Allow` l'emporte. `*` vaut n'importe quelle suite de
 *   caractères, `$` la fin du chemin. `/robots.txt` est toujours permis.
 * - Lecture : 2xx → les règles ; 4xx (sauf 429) → tout est permis ; 5xx, 429
 *   ou panne → tout est interdit (le site est peut-être en difficulté, on ne
 *   le parcourt pas à l'aveugle). Au plus 500 Kio lus.
 *
 * Le réseau est injecté (`fetchRobots`) : ce module ne lit rien lui-même.
 */

const MAX_BYTES = 500 * 1024;
const AGENT_TOKEN = 'AstratraWebBrowser';

/** Le chemin et la requête d'une adresse, encodés comme dans robots.txt. */
function pathOf(url) {
  return `${url.pathname || '/'}${url.search || ''}`;
}

/* Les octets non réservés sont décodés, pour comparer « %7E » et « ~ » ; le reste garde son encodage, en majuscules. */
function normalizePath(path) {
  return String(path).replace(/%([0-9a-fA-F]{2})/g, (whole, hex) => {
    const code = parseInt(hex, 16);
    const char = String.fromCharCode(code);
    return /[A-Za-z0-9\-._~]/.test(char) ? char : `%${hex.toUpperCase()}`;
  }).replace(/[^\x21-\x7e]/g, (char) => encodeURIComponent(char));
}

/**
 * Lit le texte d'un robots.txt.
 * @returns {{ groups: { agents: string[], rules: { allow: boolean, path: string }[] }[] }}
 */
function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? '').slice(0, MAX_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      /* « Disallow: » vide ne dit rien : tout reste permis. */
      if (!value) continue;
      current.rules.push({ allow: key === 'allow', path: normalizePath(value) });
    }
  }
  return { groups };
}

/** Le motif d'une règle en expression régulière (ancrée au début). */
function patternOf(path) {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Les règles qui s'appliquent à un agent (jeton exact, sinon `*`). */
function rulesFor(parsed, token = AGENT_TOKEN) {
  const wanted = token.toLowerCase();
  const own = parsed.groups.filter((group) => group.agents.includes(wanted));
  const chosen = own.length ? own : parsed.groups.filter((group) => group.agents.includes('*'));
  return chosen.flatMap((group) => group.rules);
}

/**
 * Vrai si l'agent peut ouvrir cette adresse.
 * @param {object} parsed  parseRobots(…), ou { allowAll: true } / { disallowAll: true }.
 * @param {string|URL} target
 */
function robotsAllows(parsed, target, token = AGENT_TOKEN) {
  if (parsed?.allowAll) return true;
  if (parsed?.disallowAll) return false;
  const url = target instanceof URL ? target : new URL(String(target));
  const path = normalizePath(pathOf(url));
  if (url.pathname === '/robots.txt') return true;
  let best = null;
  for (const rule of rulesFor(parsed, token)) {
    if (!patternOf(rule.path).test(path)) continue;
    const length = rule.path.replace(/\$$/, '').length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) best = { length, allow: rule.allow };
  }
  return best ? best.allow : true;
}

/**
 * Un cache de robots.txt par origine.
 * @param {object} options
 * @param {(url: string, ctx: { signal?: AbortSignal }) => Promise<{ status: number, body: string }>} options.fetchRobots
 *        lève sur une panne réseau.
 * @param {number} [options.ttlMs]        Défaut une heure.
 * @param {number} [options.errorTtlMs]   pour un robots.txt illisible. Défaut 10 min.
 * @param {number} [options.maxEntries]   Défaut 1 000.
 * @param {string} [options.token]
 * @param {Function} [options.now]
 */
function createRobotsCache(options = {}) {
  if (typeof options.fetchRobots !== 'function') throw new TypeError('createRobotsCache needs fetchRobots.');
  const ttlMs = options.ttlMs ?? 3_600_000;
  const errorTtlMs = options.errorTtlMs ?? 600_000;
  const maxEntries = options.maxEntries ?? 1_000;
  const token = options.token || AGENT_TOKEN;
  const now = options.now || Date.now;
  const entries = new Map();
  const pending = new Map();

  async function load(origin, signal) {
    try {
      const answer = await options.fetchRobots(`${origin}/robots.txt`, { signal });
      const status = Number(answer?.status) || 0;
      if (status >= 200 && status < 300) return { rules: parseRobots(String(answer.body ?? '').slice(0, MAX_BYTES)), ttl: ttlMs };
      if (status >= 400 && status < 500 && status !== 429) return { rules: { allowAll: true }, ttl: ttlMs };
      return { rules: { disallowAll: true, unavailable: true }, ttl: errorTtlMs };
    } catch (_error) {
      if (signal?.aborted) throw signal.reason;
      return { rules: { disallowAll: true, unavailable: true }, ttl: errorTtlMs };
    }
  }

  async function rulesOf(origin, signal) {
    const cached = entries.get(origin);
    if (cached && cached.expires > now()) return cached.rules;
    if (pending.has(origin)) return pending.get(origin);
    const job = load(origin, signal).then(({ rules, ttl }) => {
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(origin, { rules, expires: now() + ttl });
      return rules;
    }).finally(() => pending.delete(origin));
    pending.set(origin, job);
    return job;
  }

  /**
   * @returns {Promise<{ allowed: boolean, unavailable?: boolean }>}
   */
  async function check(target, { signal } = {}) {
    const url = target instanceof URL ? target : new URL(String(target));
    const rules = await rulesOf(url.origin, signal);
    return { allowed: robotsAllows(rules, url, token), ...(rules.unavailable ? { unavailable: true } : {}) };
  }

  return { check, clear: () => entries.clear(), size: () => entries.size };
}

module.exports = { parseRobots, robotsAllows, createRobotsCache, ROBOTS_AGENT_TOKEN: AGENT_TOKEN };
