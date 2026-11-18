'use strict';

const { AssertionError } = require('node:assert');
const { isDeepStrictEqual } = require('node:util');
const { createRandom, seedFromEnv } = require('./random');
const { describeValue } = require('./describe');

/**
 * Les essais métamorphiques : quand on ne connaît pas la bonne réponse pour une entrée, on vérifie une relation entre
 * deux réponses. Exemple : changer l'ordre des clés d'un objet signé ne doit jamais rendre valide ce qui ne l'était pas ;
 * une adresse écrite en majuscules désigne le même compte.
 *
 * `run(input)` rend la réponse (ou lève : c'est un refus). `relation(a, b, input, changed)` reçoit les deux issues,
 * `{ ok, value | error }`, et rend vrai si la relation tient.
 */
async function checkRelation({ inputs = [], generator, runs = 200, seed = 1, transform, run, relation = relations.same, stopAfter = 10 } = {}) {
  if (typeof transform !== 'function' || typeof run !== 'function') throw new TypeError('checkRelation needs transform and run functions.');
  const usedSeed = seedFromEnv(seed);
  const random = createRandom(usedSeed);
  const all = [...inputs];
  if (generator) for (let i = 0; i < runs; i++) all.push(generator.generate(random.fork(`run:${i}`)));
  const outcome = async (input) => {
    try {
      return { ok: true, value: await run(input) };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const failures = [];
  for (let i = 0; i < all.length && failures.length < stopAfter; i++) {
    const input = all[i];
    const changed = transform(input, random.fork(`transform:${i}`));
    const a = await outcome(input);
    const b = await outcome(changed);
    if (!(await relation(a, b, input, changed))) failures.push({ input, changed, a, b });
  }
  return { holds: failures.length === 0, checked: all.length, seed: usedSeed, failures };
}

async function assertRelation(options) {
  const report = await checkRelation(options);
  if (!report.holds) {
    const show = (o) => (o.ok ? `answered ${describeValue(o.value, 160)}` : `refused (${o.error && o.error.message})`);
    const lines = report.failures.map((f) => `  - input ${describeValue(f.input, 160)} → ${show(f.a)}\n    changed ${describeValue(f.changed, 160)} → ${show(f.b)}`);
    throw new AssertionError({ message: `${options.name ? `${options.name}: ` : ''}relation broken for ${report.failures.length} input(s) (seed ${report.seed}):\n${lines.join('\n')}` });
  }
  return report;
}

/** Les relations courantes. */
const relations = {
  /** Même réponse, ou refus des deux côtés. */
  same: (a, b) => a.ok === b.ok && (!a.ok || isDeepStrictEqual(a.value, b.value)),
  /** Les deux refusent. */
  bothRefused: (a, b) => !a.ok && !b.ok,
  /** Le changement ne fait jamais accepter ce qui était refusé (il peut faire refuser ce qui passait). */
  neverMorePermissive: (a, b) => a.ok || !b.ok,
  /** La version changée est refusée, quoi qu'il en soit de l'originale (une signature après modification). */
  changedRefused: (_a, b) => !b.ok || b.value === false,
};

/** Des transformations courantes. */
const transforms = {
  /** Les clés d'un objet (et de ses sous-objets) dans un autre ordre. */
  reorderKeys(value, random) {
    if (Array.isArray(value)) return value.map((v) => transforms.reorderKeys(v, random));
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
    const keys = random.shuffle(Object.keys(value));
    return Object.fromEntries(keys.map((k) => [k, transforms.reorderKeys(value[k], random)]));
  },
  /** Le même JSON avec d'autres espaces (une signature calculée sur le texte doit changer de verdict). */
  reformatJson: (text, random) => JSON.stringify(JSON.parse(text), null, random.pick([1, 2, '\t'])),
  upperCase: (text) => String(text).toUpperCase(),
  lowerCase: (text) => String(text).toLowerCase(),
  /** Forme décomposée (é = e + accent) : deux écritures du même texte. */
  nfd: (text) => String(text).normalize('NFD'),
  nfc: (text) => String(text).normalize('NFC'),
  /** Un caractère de largeur nulle glissé au milieu. */
  zeroWidth: (text, random) => {
    const s = String(text);
    const at = random.int(0, s.length);
    return s.slice(0, at) + random.pick(['\u200B', '\u200C', '\u200D', '\uFEFF']) + s.slice(at);
  },
  surroundingSpaces: (text) => ` ${text} `,
  /** Encodé pour une adresse (%xx), une fois de plus. */
  percentEncode: (text) => encodeURIComponent(String(text)),
  /** Un seul bit changé dans des octets ou du texte (une signature, un jeton chiffré). */
  flipBit(value, random) {
    const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value));
    if (!buffer.length) return Buffer.isBuffer(value) ? Buffer.from([1]) : '\u0001';
    const i = random.int(0, buffer.length - 1);
    buffer[i] ^= 1 << random.int(0, 7);
    return Buffer.isBuffer(value) ? buffer : buffer.toString('latin1');
  },
};

module.exports = { checkRelation, assertRelation, relations, transforms };
