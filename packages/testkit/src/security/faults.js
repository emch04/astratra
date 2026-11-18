'use strict';

const { AssertionError } = require('node:assert');

/**
 * Les pannes provoquées : une méthode d'un objet (le client Redis, la base, un fournisseur) remplacée le temps d'un
 * essai par une panne, puis remise telle quelle. Une protection doit rester fermée quand ce dont elle dépend tombe
 * (une limite de requêtes qui laisse tout passer quand Redis tombe, une vérification qui accepte quand la base ne
 * répond pas : c'est ce que ces essais doivent attraper).
 */
const faults = {
  /** Lève l'erreur donnée (ou une erreur de connexion). */
  throwing: (error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })) => () => {
    throw typeof error === 'function' ? error() : error;
  },
  /** Rejette (pour une méthode asynchrone). */
  rejecting: (error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })) => async () => {
    throw typeof error === 'function' ? error() : error;
  },
  /** Ne répond jamais (un serveur qui ne répond plus) ; `signal` permet d'abandonner. */
  hanging: () => () => new Promise(() => {}),
  /** Répond après `ms`, avec la vraie méthode. */
  delayed: (ms) => (original) =>
    async function delayedCall(...args) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return original.apply(this, args);
    },
  /** Une fois sur `every`, lève ; sinon la vraie méthode. */
  flaky: (every = 2, error) => (original) => {
    let calls = 0;
    return function flakyCall(...args) {
      calls += 1;
      if (calls % every === 0) throw error || Object.assign(new Error('flaky failure'), { code: 'ECONNRESET' });
      return original.apply(this, args);
    };
  },
  /** Rend une valeur fixe (une réponse vide, mal formée). */
  returning: (value) => () => value,
};

/**
 * Remplace `target[method]` par la panne pendant `run`, puis remet la vraie méthode (même si `run` lève). Une panne
 * reçoit la méthode d'origine (pour `delayed` et `flaky`) ; les autres l'ignorent.
 */
async function withFault(target, method, fault, run) {
  if (!target || typeof target[method] !== 'function') throw new TypeError(`withFault: ${String(method)} is not a method of the target.`);
  const original = target[method];
  const own = Object.prototype.hasOwnProperty.call(target, method);
  if (typeof fault !== 'function') throw new TypeError('withFault needs a fault (see faults).');
  // Une panne qui attend la méthode d'origine (delayed, flaky) la reçoit ; les autres sont la méthode de remplacement.
  target[method] = fault.length >= 1 ? fault(original) : fault;
  try {
    return await run();
  } finally {
    if (own) target[method] = original;
    else delete target[method];
  }
}

/**
 * La protection reste fermée pendant la panne : `run()` doit refuser (lever, ou rendre ce que `isDenied` reconnaît,
 * par défaut un statut 4xx/5xx ou `false`).
 */
async function assertFailsClosed(target, method, fault, run, { isDenied = defaultDenied, name } = {}) {
  let outcome;
  await withFault(target, method, fault, async () => {
    try {
      outcome = { ok: true, value: await run() };
    } catch (error) {
      outcome = { ok: false, error };
    }
  });
  if (outcome.ok && !isDenied(outcome.value)) {
    throw new AssertionError({ message: `${name ? `${name}: ` : ''}allowed while ${String(method)} was failing (fails open).` });
  }
  return outcome;
}

function defaultDenied(value) {
  if (value === false) return true;
  const status = typeof value === 'number' ? value : value && typeof value === 'object' ? value.status ?? value.statusCode : undefined;
  return typeof status === 'number' && status >= 400;
}

module.exports = { faults, withFault, assertFailsClosed };
