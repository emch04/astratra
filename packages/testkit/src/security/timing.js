'use strict';

const { AssertionError } = require('node:assert');
const { createRandom, seedFromEnv } = require('./random');

/**
 * Le temps constant, mesuré à la manière de dudect (Reparaz, Balasch, Verbauwhede, 2017) : deux familles d'entrées
 * (par exemple un secret faux dès le premier caractère, et un secret faux seulement au dernier) sont chronométrées en
 * alternance au hasard ; un test t de Welch dit si les deux durées diffèrent. |t| au-delà de 5 trahit presque
 * sûrement une fuite. C'est un indice statistique, pas une preuve : une mesure sans fuite ne démontre rien, et une
 * machine chargée peut produire du bruit, d'où plusieurs tentatives (la fuite doit se voir à chacune).
 */
function measureTiming(fn, { classes, samples = 4_000, batch = 8, warmup = 500, seed = 1, copyInputs = true } = {}) {
  if (typeof fn !== 'function' || !Array.isArray(classes) || classes.length !== 2) throw new TypeError('measureTiming needs fn and two input classes (functions).');
  const random = createRandom(seedFromEnv(seed));
  const make = classes.map((c) => (typeof c === 'function' ? c : () => c));
  for (let i = 0; i < warmup; i++) fn(make[i % 2](random));
  const times = [[], []];
  for (let i = 0; i < samples; i++) {
    const which = random.chance(0.5) ? 1 : 0;
    // Un même tampon, toujours à la même adresse, change la mesure par le seul effet du cache : chaque tampon est
    // recopié avant la mesure (hors du temps chronométré), pour que seule la valeur compte.
    const inputs = Array.from({ length: batch }, () => {
      const input = make[which](random);
      return copyInputs && ArrayBuffer.isView(input) ? Buffer.from(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)) : input;
    });
    const started = process.hrtime.bigint();
    for (const input of inputs) fn(input);
    times[which].push(Number(process.hrtime.bigint() - started) / batch);
  }
  // Comme dudect : plusieurs coupes des valeurs extrêmes (interruptions, ramasse-miettes), la plus forte différence compte.
  const all = [...times[0], ...times[1]].sort((a, b) => a - b);
  let worst = { t: 0 };
  for (const percentile of [1, 0.99, 0.95, 0.9, 0.75, 0.5]) {
    const cap = all[Math.min(all.length - 1, Math.floor(all.length * percentile))];
    const a = times[0].filter((x) => x <= cap);
    const b = times[1].filter((x) => x <= cap);
    if (a.length < 10 || b.length < 10) continue;
    const t = welch(a, b);
    if (Math.abs(t) > Math.abs(worst.t)) worst = { t, percentile, meanA: mean(a), meanB: mean(b), countA: a.length, countB: b.length };
  }
  return { ...worst, t: worst.t, absT: Math.abs(worst.t) };
}

function checkConstantTime(fn, { threshold = 5, attempts = 3, ...options } = {}) {
  const runs = [];
  for (let i = 0; i < attempts; i++) {
    const run = measureTiming(fn, { ...options, seed: `${options.seed ?? 1}:${i}` });
    runs.push(run);
    if (run.absT <= threshold) return { constant: true, threshold, runs };
  }
  return { constant: false, threshold, runs };
}

function assertConstantTime(fn, options = {}) {
  const report = checkConstantTime(fn, options);
  if (!report.constant) {
    const lines = report.runs.map((r, i) => `  attempt ${i + 1}: |t| = ${r.absT.toFixed(1)} (means ${r.meanA?.toFixed(0)} ns vs ${r.meanB?.toFixed(0)} ns)`);
    throw new AssertionError({ message: `${options.name ? `${options.name}: ` : ''}timing depends on the input (|t| > ${report.threshold} at every attempt):\n${lines.join('\n')}` });
  }
  return report;
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
function variance(xs, m) {
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}
function welch(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  const denom = Math.sqrt(variance(a, ma) / a.length + variance(b, mb) / b.length);
  return denom === 0 ? 0 : (ma - mb) / denom;
}

module.exports = { measureTiming, checkConstantTime, assertConstantTime, welchT: welch };
