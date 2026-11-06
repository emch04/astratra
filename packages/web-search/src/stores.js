/**
 * Les magasins par défaut : un cache et des compteurs de quotas en mémoire.
 *
 * Ce sont des interfaces, à remplacer par Redis ou une base quand plusieurs
 * processus partagent le même budget :
 *   cache  : { get(key) => value | undefined, set(key, value, ttlMs) }
 *   quotas : { get(key) => number, incr(key, ttlMs) => number }
 * Toutes les méthodes peuvent être asynchrones.
 */

/** Un cache en mémoire, borné : le plus ancien part quand il est plein. */
function createMemoryCache({ maxEntries = 500, now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return globalThis.structuredClone(entry.value);
    },
    set(key, value, ttlMs) {
      if (!(ttlMs > 0)) return;
      entries.delete(key);
      entries.set(key, { value: globalThis.structuredClone(value), expires: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    clear() {
      entries.clear();
    },
    size: () => entries.size
  };
}

/** Des compteurs en mémoire, chacun oublié à l'échéance de sa fenêtre. */
function createMemoryCounters({ now = Date.now } = {}) {
  const counters = new Map();
  const live = (key) => {
    const counter = counters.get(key);
    if (counter && counter.expires <= now()) {
      counters.delete(key);
      return null;
    }
    return counter || null;
  };
  return {
    get(key) {
      return live(key)?.count || 0;
    },
    incr(key, ttlMs) {
      const counter = live(key) || { count: 0, expires: now() + ttlMs };
      counter.count += 1;
      counters.set(key, counter);
      return counter.count;
    }
  };
}

module.exports = { createMemoryCache, createMemoryCounters };
