'use strict';

const { AssertionError } = require('node:assert');
const { createRandom, seedFromEnv } = require('./random');
const { describeValue } = require('./describe');

/**
 * Une règle vraie pour toute entrée : `property(value)` rend vrai, ou lève. Au premier échec, l'entrée est réduite à la
 * plus petite qui échoue encore, et le rapport donne la graine et le numéro de l'essai pour le rejouer.
 */
async function checkProperty(generator, property, { runs = 200, seed = 1, maxShrinks = 500 } = {}) {
  if (!generator || typeof generator.generate !== 'function') throw new TypeError('checkProperty needs a generator.');
  if (typeof property !== 'function') throw new TypeError('checkProperty needs a property function.');
  const usedSeed = seedFromEnv(seed);
  const random = createRandom(usedSeed);
  const fails = async (value) => {
    try {
      return (await property(value)) === false ? { message: 'property returned false' } : null;
    } catch (error) {
      return { message: error && error.message ? error.message : String(error), error };
    }
  };
  for (let run = 0; run < runs; run++) {
    const value = generator.generate(random.fork(`run:${run}`));
    const failure = await fails(value);
    if (!failure) continue;
    let smallest = value;
    let smallestFailure = failure;
    let shrinks = 0;
    let improved = true;
    while (improved && shrinks < maxShrinks) {
      improved = false;
      for (const candidate of generator.shrink(smallest)) {
        if (++shrinks > maxShrinks) break;
        const candidateFailure = await fails(candidate);
        if (candidateFailure) {
          smallest = candidate;
          smallestFailure = candidateFailure;
          improved = true;
          break;
        }
      }
    }
    return { passed: false, runs: run + 1, seed: usedSeed, run, original: value, counterexample: smallest, shrinks, message: smallestFailure.message, error: smallestFailure.error };
  }
  return { passed: true, runs, seed: usedSeed };
}

async function assertProperty(generator, property, options = {}) {
  const report = await checkProperty(generator, property, options);
  if (!report.passed) {
    throw new AssertionError({
      message: `${options.name ? `${options.name}: ` : ''}property failed after ${report.runs} run(s) (seed ${report.seed}, run ${report.run}, ${report.shrinks} shrink step(s)).\nSmallest counterexample: ${describeValue(report.counterexample)}\nReason: ${report.message}\nReplay with SECURITY_TEST_SEED=${report.seed}.`,
    });
  }
  return report;
}

module.exports = { checkProperty, assertProperty };
