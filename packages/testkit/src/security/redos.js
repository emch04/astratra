'use strict';

const { AssertionError } = require('node:assert');
const { Worker } = require('node:worker_threads');
const { describeValue } = require('./describe');

/**
 * Les expressions régulières qui s'emballent (ReDoS). Une entrée d'attaque se construit en trois parties : un début qui
 * atteint la partie fragile, un morceau répété n fois, une fin qui fait échouer la correspondance (le moteur essaie
 * alors tous les découpages). Chaque expression est essayée dans un fil d'exécution à part, arrêté net s'il dépasse le
 * temps permis : une expression exponentielle ne bloque jamais l'essai lui-même.
 *
 * Règle : une entrée de `maxLength` caractères au plus doit être traitée en moins de `maxMs` millisecondes.
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const regex = new RegExp(workerData.source, workerData.flags.replace(/[gy]/g, ''));
parentPort.on('message', (input) => {
  const started = process.hrtime.bigint();
  regex.test(input);
  parentPort.postMessage(Number(process.hrtime.bigint() - started) / 1e6);
});
`;

function attackCandidates(regex) {
  const source = regex.source;
  const samples = new Set(['a', '0', ' ', '\t', '-', '.', '_', '/', '@', 'A', '=', ',', ':', '\n', 'é']);
  const classes = { '\\d': '0', '\\w': 'a', '\\s': ' ', '\\D': 'a', '\\W': '!', '\\S': 'a', '.': 'a' };
  for (const [token, sample] of Object.entries(classes)) if (source.includes(token)) samples.add(sample);
  for (const match of source.matchAll(/\[(\^?)([^\]]*)\]/g)) {
    const body = match[2].replace(/\\(.)/g, '$1');
    if (match[1]) continue;
    if (body[0]) samples.add(body[0]);
    const range = /(.)-(.)/.exec(body);
    if (range) samples.add(range[2]);
  }
  for (const ch of source.replace(/\\[dwsDWSbB]|\[[^\]]*\]|[()?*+{}|^$.\\]/g, '')) if (ch.trim() || ch === ' ') samples.add(ch);
  const list = [...samples].slice(0, 24);
  const pumps = new Set(list);
  for (const a of list.slice(0, 6)) for (const b of list.slice(0, 6)) if (a !== b) pumps.add(a + b);
  const literalPrefix = /^\^?((?:[^\\[\]()?*+{}|^$.]|\\[^dwsDWSbB])*)/.exec(source)?.[1]?.replace(/\\(.)/g, '$1') ?? '';
  const prefixes = literalPrefix ? ['', literalPrefix] : [''];
  const suffixes = ['!', '\u0000', '\n', '"', 'Ω', '1', 'a!'];
  const out = [];
  for (const prefix of prefixes) for (const pump of pumps) for (const suffix of suffixes) out.push({ prefix, pump, suffix });
  return out;
}

/**
 * Essaie `regex` avec des entrées d'attaque de longueur croissante. `attacks` remplace les entrées devinées
 * ({ prefix, pump, suffix }) ; sinon elles sont tirées des caractères de l'expression.
 */
async function checkRegex(regex, { maxMs = 50, maxLength = 50_000, attacks } = {}) {
  if (!(regex instanceof RegExp)) throw new TypeError('checkRegex needs a RegExp.');
  const candidates = attacks ?? attackCandidates(regex);
  // Une seule longueur, la plus grande : un emballement quadratique ne se voit qu'avec une longue entrée, et un
  // emballement exponentiel y dépasse aussi le temps permis (le fil est alors arrêté).
  const lengths = [maxLength];
  let worker = null;
  const start = () => {
    worker = new Worker(WORKER, { eval: true, workerData: { source: regex.source, flags: regex.flags } });
    worker.unref();
  };
  const run = (input) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        worker.terminate();
        worker = null;
        resolve(Infinity);
      }, maxMs * 4 + 100);
      const onMessage = (ms) => {
        cleanup();
        resolve(ms);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker?.off('message', onMessage);
        worker?.off('error', onError);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.postMessage(input);
    });
  try {
    for (const attack of candidates) {
      for (const length of lengths) {
        const repeat = Math.max(1, Math.floor((length - attack.prefix.length - attack.suffix.length) / attack.pump.length));
        const input = attack.prefix + attack.pump.repeat(repeat) + attack.suffix;
        if (!worker) start();
        const ms = await run(input);
        if (ms > maxMs) return { safe: false, regex: String(regex), attack, length: input.length, ms, input };
      }
    }
    return { safe: true, regex: String(regex), tried: candidates.length };
  } finally {
    if (worker) await worker.terminate();
  }
}

async function assertSafeRegex(regex, options = {}) {
  const report = await checkRegex(regex, options);
  if (!report.safe) {
    const ms = report.ms === Infinity ? `more than ${(options.maxMs ?? 50) * 4 + 100} ms (stopped)` : `${report.ms.toFixed(1)} ms`;
    throw new AssertionError({
      message: `${report.regex} backtracks on a ${report.length}-character input: ${ms}.\nAttack: prefix ${describeValue(report.attack.prefix)}, pump ${describeValue(report.attack.pump)} repeated, suffix ${describeValue(report.attack.suffix)}.`,
    });
  }
  return report;
}

/** Les expressions écrites dans un texte source (littéraux /…/flags), pour les essayer toutes. */
function extractRegexLiterals(sourceText) {
  const out = [];
  // Un littéral ne suit qu'un opérateur, une ouverture ou « return » : « a / b / c » est une division.
  const pattern = /(?<=(?:^|[=(,:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase)\s*)\/(?![*/\s])((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/([dgimsuvy]*)/gm;
  for (const match of sourceText.matchAll(pattern)) {
    try {
      out.push(new RegExp(match[1], match[2]));
    } catch {
      // Une division prise pour une expression : ignorée.
    }
  }
  return out;
}

/**
 * Une fonction, pas seulement une expression : comment son temps grandit avec la taille de l'entrée. L'exposant
 * mesuré vaut environ 1 pour un temps linéaire, 2 pour un temps quadratique ; au-delà de `maxExponent` (1,5 par
 * défaut), la fonction s'emballe sur une entrée longue. Mesurée ici même : on part de petites tailles pour qu'une
 * fonction exponentielle dépasse `maxMs` avant de tout bloquer.
 */
function checkLinearTime(fn, { build, sizes = [2_000, 4_000, 8_000, 16_000, 32_000], repeats = 5, maxExponent = 1.5, minMs = 2, maxMs = 1_000 } = {}) {
  if (typeof fn !== 'function' || typeof build !== 'function') throw new TypeError('checkLinearTime needs fn and build(size).');
  const timings = [];
  for (const size of sizes) {
    const input = build(size);
    // Un premier appel hors mesure : la compilation à la volée ne doit pas fausser les petites tailles.
    try {
      fn(input);
    } catch {
      // Un refus est une réponse.
    }
    const runs = [];
    for (let i = 0; i < repeats; i++) {
      const started = process.hrtime.bigint();
      try {
        fn(input);
      } catch {
        // Un refus est une réponse : seul le temps compte ici.
      }
      runs.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    runs.sort((a, b) => a - b);
    const ms = runs[Math.floor(runs.length / 2)];
    timings.push({ size, ms });
    if (ms > maxMs) return { linear: false, timings, exponent: Infinity, reason: `${ms.toFixed(1)} ms for size ${size} (limit ${maxMs} ms)` };
  }
  // Les mesures trop courtes ne disent rien (bruit de l'horloge) : l'exposant se calcule sur les autres.
  const usable = timings.filter((t) => t.ms >= minMs);
  if (usable.length < 2) return { linear: true, timings, exponent: null };
  const first = usable[0];
  const last = usable[usable.length - 1];
  const exponent = Math.log(last.ms / first.ms) / Math.log(last.size / first.size);
  if (exponent > maxExponent) return { linear: false, timings, exponent, reason: `time grows like size^${exponent.toFixed(2)} between sizes ${first.size} and ${last.size} (limit ${maxExponent})` };
  return { linear: true, timings, exponent };
}

function assertLinearTime(fn, options = {}) {
  const report = checkLinearTime(fn, options);
  if (!report.linear) throw new AssertionError({ message: `${options.name ? `${options.name}: ` : ''}not linear: ${report.reason}.\n${report.timings.map((t) => `  size ${t.size}: ${t.ms.toFixed(2)} ms`).join('\n')}` });
  return report;
}

module.exports = { checkRegex, assertSafeRegex, attackCandidates, extractRegexLiterals, checkLinearTime, assertLinearTime };
