'use strict';

const { AssertionError } = require('node:assert');

/**
 * Les courses : la même opération lancée N fois au même instant (un double paiement, la dernière place prise deux fois,
 * un code à usage unique servi deux fois). Toutes les tâches attendent un même signal avant de partir, pour se
 * chevaucher le plus possible. `run(index)` rend une valeur, ou lève : chaque issue est gardée.
 */
async function race(run, { concurrency = 50 } = {}) {
  if (typeof run !== 'function') throw new TypeError('race needs a function.');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tasks = Array.from({ length: concurrency }, async (_, index) => {
    await gate;
    try {
      return { index, ok: true, value: await run(index) };
    } catch (error) {
      return { index, ok: false, error };
    }
  });
  release();
  const outcomes = await Promise.all(tasks);
  return { outcomes, succeeded: outcomes.filter((o) => o.ok), failed: outcomes.filter((o) => !o.ok) };
}

/**
 * Au plus `max` issues réussies (par défaut une seule) : `isSuccess(outcome)` dit ce qui compte comme un succès (par
 * défaut : pas d'erreur, et pas de statut 4xx/5xx si la valeur en porte un).
 */
async function assertAtMost(run, { max = 1, concurrency = 50, isSuccess = defaultSuccess, name } = {}) {
  const result = await race(run, { concurrency });
  const successes = result.outcomes.filter(isSuccess);
  if (successes.length > max) {
    throw new AssertionError({ message: `${name ? `${name}: ` : ''}${successes.length} of ${concurrency} concurrent attempts succeeded (at most ${max} allowed).` });
  }
  return { ...result, successes };
}

function defaultSuccess(outcome) {
  if (!outcome.ok) return false;
  const status = outcome.value && typeof outcome.value === 'object' ? outcome.value.status ?? outcome.value.statusCode : undefined;
  return typeof status === 'number' ? status < 400 : outcome.value !== false;
}

module.exports = { race, assertAtMost };
