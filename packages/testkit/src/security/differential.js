'use strict';

const { AssertionError } = require('node:assert');
const { isDeepStrictEqual } = require('node:util');
const { createRandom, seedFromEnv } = require('./random');
const { describeValue } = require('./describe');

/**
 * Le différentiel : les mêmes entrées données à l'implémentation de référence (la bibliothèque qu'on remplace) et à la
 * nôtre. Pour chaque entrée, les deux doivent répondre pareil : même valeur (après `normalize`), ou refus toutes les
 * deux. `normalizeError` dit ce qui compte dans un refus (par défaut : seulement qu'il y a refus).
 */
async function compareImplementations({ reference, candidate, inputs = [], generator, runs = 500, seed = 1, normalize = (v) => v, normalizeError = () => 'refused', equal = isDeepStrictEqual, stopAfter = 10 } = {}) {
  if (typeof reference !== 'function' || typeof candidate !== 'function') throw new TypeError('compareImplementations needs reference and candidate functions.');
  const usedSeed = seedFromEnv(seed);
  const random = createRandom(usedSeed);
  const all = [...inputs];
  if (generator) for (let i = 0; i < runs; i++) all.push(generator.generate(random.fork(`run:${i}`)));
  const outcome = async (fn, input) => {
    try {
      return { ok: true, value: normalize(await fn(input), input) };
    } catch (error) {
      return { ok: false, value: normalizeError(error, input), message: error && error.message };
    }
  };
  const mismatches = [];
  for (let i = 0; i < all.length && mismatches.length < stopAfter; i++) {
    const input = all[i];
    const ref = await outcome(reference, input);
    const cand = await outcome(candidate, input);
    if (ref.ok !== cand.ok || !equal(ref.value, cand.value)) mismatches.push({ index: i, input, reference: ref, candidate: cand });
  }
  return { same: mismatches.length === 0, compared: all.length, seed: usedSeed, mismatches };
}

async function assertSameBehavior(options) {
  const report = await compareImplementations(options);
  if (!report.same) {
    const show = (o) => (o.ok ? `answered ${describeValue(o.value, 200)}` : `refused (${describeValue(o.value, 120)}${o.message ? `: ${o.message}` : ''})`);
    const lines = report.mismatches.map((m) => `  - input ${describeValue(m.input, 200)}\n    reference ${show(m.reference)}\n    candidate ${show(m.candidate)}`);
    throw new AssertionError({ message: `${options.name ? `${options.name}: ` : ''}${report.mismatches.length} difference(s) over ${report.compared} input(s) (seed ${report.seed}):\n${lines.join('\n')}` });
  }
  return report;
}

module.exports = { compareImplementations, assertSameBehavior };
