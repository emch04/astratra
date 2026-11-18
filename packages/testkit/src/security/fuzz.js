'use strict';

const { AssertionError } = require('node:assert');
const { createRandom, seedFromEnv } = require('./random');
const { describeValue } = require('./describe');

/**
 * Le fuzz : des milliers d'entrées hostiles envoyées à `target`. Un essai échoue quand la cible
 *   - lève une erreur qui n'est pas un refus attendu. Par défaut (`isExpectedError`), un refus porte un statut 4xx
 *     (`status` ou `statusCode`) ou un `code` à soi (pas « ERR_… » de Node) ; une TypeError, RangeError,
 *     ReferenceError ou SyntaxError est toujours un plantage, même avec un code ;
 *   - met plus de `timeoutMs` à répondre (une expression régulière qui s'emballe, une boucle sans fin) ;
 *   - rend un résultat que `check(result, input)` refuse (une règle de sécurité violée).
 * Chaque échec donne la graine et le numéro de l'essai : SECURITY_TEST_SEED le rejoue exactement.
 */
async function fuzz(target, { generator, runs = 1000, seed = 1, timeoutMs = 250, isExpectedError = defaultExpectedError, check, stopAfter = 5 } = {}) {
  if (typeof target !== 'function') throw new TypeError('fuzz needs a target function.');
  if (!generator || typeof generator.generate !== 'function') throw new TypeError('fuzz needs a generator (see gen).');
  const usedSeed = seedFromEnv(seed);
  const random = createRandom(usedSeed);
  const failures = [];
  let slowest = 0;
  for (let run = 0; run < runs && failures.length < stopAfter; run++) {
    const input = generator.generate(random.fork(`run:${run}`));
    const started = process.hrtime.bigint();
    let outcome;
    try {
      const value = target(input);
      const result = value && typeof value.then === 'function' ? await withTimeout(value, timeoutMs) : value;
      outcome = { result };
    } catch (error) {
      outcome = { error };
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    slowest = Math.max(slowest, ms);
    const base = { run, seed: usedSeed, input, ms };
    if (outcome.error && outcome.error.code === 'FUZZ_TIMEOUT') failures.push({ ...base, kind: 'timeout', message: `no answer after ${timeoutMs} ms` });
    else if (ms > timeoutMs) failures.push({ ...base, kind: 'slow', message: `answered after ${ms.toFixed(1)} ms (limit ${timeoutMs} ms)` });
    else if (outcome.error && !isExpectedError(outcome.error, input)) failures.push({ ...base, kind: 'crash', message: errorText(outcome.error), error: outcome.error });
    else if (!outcome.error && check) {
      let verdict;
      try {
        verdict = await check(outcome.result, input);
      } catch (error) {
        verdict = errorText(error);
      }
      if (verdict === false || typeof verdict === 'string') failures.push({ ...base, kind: 'check', message: typeof verdict === 'string' ? verdict : 'check returned false', result: outcome.result });
    }
  }
  return { passed: failures.length === 0, runs, seed: usedSeed, slowestMs: slowest, failures };
}

async function assertFuzz(target, options = {}) {
  const report = await fuzz(target, options);
  if (!report.passed) {
    const lines = report.failures.map((f) => `  - run ${f.run} [${f.kind}] ${f.message}\n    input: ${describeValue(f.input)}`);
    throw new AssertionError({ message: `${options.name ? `${options.name}: ` : ''}fuzz found ${report.failures.length} failure(s) (seed ${report.seed}):\n${lines.join('\n')}\nReplay with SECURITY_TEST_SEED=${report.seed}.` });
  }
  return report;
}

/** Un refus voulu porte un code ou un statut HTTP 4xx ; un plantage (TypeError, RangeError…) n'en porte pas. */
function defaultExpectedError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError) return false;
  const status = Number(error.status ?? error.statusCode);
  if (status >= 400 && status < 500) return true;
  return typeof error.code === 'string' && error.code.length > 0 && !error.code.startsWith('ERR_');
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'FUZZ_TIMEOUT' })), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

const errorText = (error) => (error && error.stack ? String(error.stack).split('\n').slice(0, 3).join(' | ') : String(error));

module.exports = { fuzz, assertFuzz, defaultExpectedError };
