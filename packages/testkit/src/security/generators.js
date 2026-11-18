'use strict';

const { payloads } = require('./payloads');

/**
 * Des générateurs d'entrées : `generate(random)` fabrique une valeur, `shrink(value)` propose des valeurs plus petites
 * pour réduire un échec à son plus petit exemple. Partagés par les essais de propriétés et le fuzz.
 */
const make = (generate, shrink = () => []) => ({ generate, shrink });

const ALPHABETS = {
  alnum: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ascii: Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join(''),
  // Les caractères qui cassent le plus souvent un analyseur : séparateurs, guillemets, contrôles, échappements.
  hostile: `\0\t\n\r "'\`\\/<>&;:=?#%{}[]()$*.,|!~@+-_\u2028\u2029\u200B\uFEFF\u202E𐀀éé￿`,
};

function shrinkString(value) {
  const out = [];
  if (value.length === 0) return out;
  out.push('');
  if (value.length > 1) {
    out.push(value.slice(0, Math.floor(value.length / 2)));
    out.push(value.slice(Math.floor(value.length / 2)));
  }
  const step = Math.max(1, Math.floor(value.length / 16));
  for (let i = 0; i < value.length; i += step) out.push(value.slice(0, i) + value.slice(i + step));
  return out;
}

function shrinkArray(value, shrinkItem) {
  const out = [];
  if (!value.length) return out;
  out.push([]);
  if (value.length > 1) {
    out.push(value.slice(0, Math.floor(value.length / 2)));
    out.push(value.slice(Math.floor(value.length / 2)));
  }
  for (let i = 0; i < value.length && i < 32; i++) out.push([...value.slice(0, i), ...value.slice(i + 1)]);
  for (let i = 0; i < value.length && i < 8; i++) for (const smaller of shrinkItem(value[i]).slice(0, 24)) out.push([...value.slice(0, i), smaller, ...value.slice(i + 1)]);
  return out;
}

const gen = {
  constant: (value) => make(() => value),

  integer(min = -1000, max = 1000) {
    return make(
      (random) => (random.chance(0.15) ? random.pick([min, max, Math.max(min, Math.min(max, 0))]) : random.int(min, max)),
      (value) => {
        const target = Math.max(min, Math.min(max, 0));
        if (value === target) return [];
        const out = [target];
        let step = Math.trunc((value - target) / 2);
        while (step !== 0) {
          out.push(value - step);
          step = Math.trunc(step / 2);
        }
        return out;
      },
    );
  },

  /** Les nombres qui piègent : bornes, -0, NaN, infinis, au-delà des entiers exacts. */
  edgeNumber: () => make((random) => random.pick(payloads.numbers)),

  boolean: () => make((random) => random.chance(0.5), (value) => (value ? [false] : [])),

  elements(list) {
    if (!list.length) throw new RangeError('elements() needs a non-empty list.');
    return make((random) => random.pick(list), (value) => (list.indexOf(value) > 0 ? [list[0]] : []));
  },

  oneOf(...generators) {
    if (!generators.length) throw new RangeError('oneOf() needs at least one generator.');
    return make(
      (random) => random.pick(generators).generate(random),
      (value) => generators.flatMap((g) => g.shrink(value)).slice(0, 32),
    );
  },

  string({ min = 0, max = 64, alphabet = 'ascii' } = {}) {
    const chars = Array.from(ALPHABETS[alphabet] ?? alphabet);
    return make(
      (random) => {
        const length = random.chance(0.1) ? random.pick([min, max]) : random.int(min, max);
        let out = '';
        for (let i = 0; i < length; i++) out += random.pick(chars);
        return out;
      },
      (value) => shrinkString(value).filter((s) => s.length >= min),
    );
  },

  /** Un texte hostile : une entrée du catalogue, parfois entourée ou répétée. */
  hostileString() {
    const list = payloads.all();
    return make(
      (random) => {
        const base = random.pick(list);
        const roll = random.float();
        if (roll < 0.15) return base.repeat(random.int(2, 50));
        if (roll < 0.3) return `${random.pick(list)}${base}`;
        return base;
      },
      shrinkString,
    );
  },

  bytes({ min = 0, max = 256 } = {}) {
    return make(
      (random) => random.bytes(random.int(min, max)),
      (value) => (value.length > min ? [value.subarray(0, Math.max(min, Math.floor(value.length / 2))), value.subarray(0, Math.max(min, value.length - 1))] : []),
    );
  },

  array(item, { min = 0, max = 16 } = {}) {
    return make(
      (random) => Array.from({ length: random.int(min, max) }, () => item.generate(random)),
      (value) => shrinkArray(value, item.shrink).filter((a) => a.length >= min),
    );
  },

  record(shape) {
    const keys = Object.keys(shape);
    return make(
      (random) => Object.fromEntries(keys.map((k) => [k, shape[k].generate(random)])),
      (value) => keys.flatMap((k) => shape[k].shrink(value[k]).slice(0, 8).map((smaller) => ({ ...value, [k]: smaller }))),
    );
  },

  /** Une valeur JSON quelconque, d'une profondeur bornée, avec des clés piégées de temps en temps. */
  json({ depth = 4 } = {}) {
    const leaf = gen.oneOf(gen.integer(), gen.edgeNumber(), gen.boolean(), gen.constant(null), gen.string({ max: 16, alphabet: 'hostile' }), gen.hostileString());
    const build = (random, level) => {
      const roll = random.float();
      if (level <= 0 || roll < 0.4) return leaf.generate(random);
      if (roll < 0.7) return Array.from({ length: random.int(0, 4) }, () => build(random, level - 1));
      const out = {};
      for (let i = random.int(0, 4); i > 0; i--) {
        const key = random.chance(0.1) ? random.pick(payloads.prototypeKeys) : random.chance(0.1) ? `$${random.pick(['ne', 'gt', 'where', 'regex'])}` : gen.string({ min: 1, max: 8, alphabet: 'alnum' }).generate(random);
        if (key === '__proto__') Object.defineProperty(out, key, { value: build(random, level - 1), enumerable: true, configurable: true, writable: true });
        else out[key] = build(random, level - 1);
      }
      return out;
    };
    return make((random) => build(random, depth), (value) => (Array.isArray(value) ? shrinkArray(value, () => []) : typeof value === 'string' ? shrinkString(value) : []));
  },

  /** Des variantes d'entrées valides : un octet changé, un morceau répété ou coupé, une attaque insérée. */
  mutated(seeds) {
    if (!Array.isArray(seeds) || !seeds.length) throw new RangeError('mutated() needs a non-empty list of seed inputs.');
    const hostile = payloads.all();
    return make(
      (random) => {
        let value = random.pick(seeds);
        for (let n = random.int(1, 4); n > 0; n--) value = mutateOnce(value, random, hostile);
        return value;
      },
      (value) => (typeof value === 'string' ? shrinkString(value) : Buffer.isBuffer(value) ? [value.subarray(0, Math.floor(value.length / 2))] : []),
    );
  },

  map(generator, transform) {
    return make((random) => transform(generator.generate(random)));
  },
};

function mutateOnce(value, random, hostile) {
  const isBuffer = Buffer.isBuffer(value);
  const text = isBuffer ? null : String(value);
  const length = isBuffer ? value.length : text.length;
  const at = random.int(0, length);
  const op = random.int(0, 8);
  if (isBuffer) {
    const copy = Buffer.from(value);
    if (op <= 1 && copy.length) {
      const i = random.int(0, copy.length - 1);
      copy[i] ^= 1 << random.int(0, 7);
      return copy;
    }
    if (op === 2) return Buffer.concat([copy.subarray(0, at), random.bytes(random.int(1, 8)), copy.subarray(at)]);
    if (op === 3) return copy.subarray(0, at);
    if (op === 4) return Buffer.concat([copy.subarray(0, at), Buffer.from(random.pick(hostile)), copy.subarray(at)]);
    if (op === 5 && copy.length) {
      const end = random.int(at, length);
      return Buffer.concat([copy.subarray(0, end), Buffer.concat(Array(random.int(2, 64)).fill(copy.subarray(at, end))), copy.subarray(end)]);
    }
    return Buffer.concat([copy.subarray(0, at), Buffer.from([random.pick([0x00, 0xff, 0x80, 0xc0, 0x22, 0x5c, 0x0a, 0x0d])]), copy.subarray(at)]);
  }
  if (op <= 1 && length) {
    const i = random.int(0, length - 1);
    return text.slice(0, i) + String.fromCharCode(text.charCodeAt(i) ^ (1 << random.int(0, 6))) + text.slice(i + 1);
  }
  if (op === 2) return text.slice(0, at) + random.pick(Array.from(ALPHABETS.hostile)) + text.slice(at);
  if (op === 3) return text.slice(0, at);
  if (op === 4) return text.slice(0, at) + random.pick(hostile) + text.slice(at);
  if (op === 5 && length) {
    const end = random.int(at, length);
    return text.slice(0, end) + text.slice(at, end).repeat(random.int(2, 64)) + text.slice(end);
  }
  if (op === 6 && length) {
    const end = random.int(at, length);
    return text.slice(0, at) + text.slice(end);
  }
  if (op === 7) return text.slice(0, at) + random.pick(['\uD800', '\u0000', '\r\n', '"', "'", '\\', '%00', '%', '\u2028']) + text.slice(at);
  return text + text;
}

module.exports = { gen, ALPHABETS };
