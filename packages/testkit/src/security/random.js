'use strict';

/**
 * Un hasard à graine fixe (sfc32, amorcé par splitmix32) : la même graine rejoue exactement les mêmes entrées, ce qui
 * rend chaque échec reproductible. Ce n'est pas un générateur cryptographique ; il ne sert qu'à fabriquer des essais.
 */
function createRandom(seed = 1) {
  let s = (typeof seed === 'string' ? hashString(seed) : Number(seed) >>> 0) || 0x9e3779b9;
  const split = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = split(), b = split(), c = split(), d = split();
  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  const random = {
    /** Un entier de 32 bits. */
    uint32: next,
    /** Un nombre dans [0, 1). */
    float: () => next() / 4294967296,
    /** Un entier dans [min, max], bornes comprises. */
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError('int(min, max) needs integers with min <= max.');
      return min + Math.floor(random.float() * (max - min + 1));
    },
    /** Vrai avec la probabilité donnée. */
    chance: (probability) => random.float() < probability,
    /** Un élément d'une liste non vide. */
    pick(list) {
      if (!list || !list.length) throw new RangeError('pick() needs a non-empty list.');
      return list[random.int(0, list.length - 1)];
    },
    /** Des octets. */
    bytes(length) {
      const out = Buffer.alloc(length);
      for (let i = 0; i < length; i++) out[i] = next() & 0xff;
      return out;
    },
    /** Une copie mélangée. */
    shuffle(list) {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = random.int(0, i);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    /** Un hasard dérivé, indépendant pour une étape (une graine par essai). */
    fork: (label = '') => createRandom(hashString(`${next()}:${label}`)),
  };
  return random;
}

/** FNV-1a sur 32 bits : une graine texte devient un nombre. */
function hashString(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** La graine d'un lancement : SECURITY_TEST_SEED si elle est posée (pour rejouer un échec), sinon celle donnée. */
function seedFromEnv(fallback = 1) {
  const fromEnv = process.env.SECURITY_TEST_SEED;
  if (fromEnv === undefined || fromEnv === '') return fallback;
  return /^\d+$/.test(fromEnv) ? Number(fromEnv) : fromEnv;
}

module.exports = { createRandom, hashString, seedFromEnv };
