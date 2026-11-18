'use strict';

const { AssertionError } = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Les mutations : chaque cas casse volontairement une ligne du code à protéger (une condition inversée, une vérification
 * retirée), puis lance les essais. Une mutation doit être « tuée » : au moins un essai échoue. Une mutation qui survit
 * montre un code que les essais ne protègent pas. Le fichier est toujours remis tel quel, même si l'essai plante ou si
 * le processus est interrompu (Ctrl+C).
 *
 * Chaque cas : { name, file, before, after } (le texte `before` doit apparaître une seule fois dans le fichier).
 * `command` : [programme, ...arguments] (par défaut `npm test`), lancé dans `cwd`.
 */
function runMutations({ cwd = process.cwd(), cases, command = ['npm', ['test']], timeoutMs = 10 * 60 * 1000, env = process.env, onResult, baseline = true } = {}) {
  if (!Array.isArray(cases) || !cases.length) throw new TypeError('runMutations needs a non-empty list of cases.');
  const [program, args] = Array.isArray(command[1]) ? command : [command[0], command.slice(1)];
  // Sans mutation, les essais doivent passer : sinon chaque mutation paraîtrait « tuée » sans rien prouver.
  if (baseline) {
    const clean = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32' });
    if (clean.status !== 0) throw new Error(`runMutations: the tests already fail without any mutation (exit ${clean.status}); fix them first.\n${`${clean.stdout || ''}${clean.stderr || ''}`.slice(-2000)}`);
  }
  const results = [];
  for (const mutation of cases) {
    const file = path.resolve(cwd, mutation.file);
    const original = fs.readFileSync(file, 'utf8');
    const count = original.split(mutation.before).length - 1;
    if (count !== 1) throw new Error(`Mutation "${mutation.name}": the text to replace appears ${count} time(s) in ${mutation.file} (it must appear exactly once).`);
    const restore = () => fs.writeFileSync(file, original);
    const onSignal = (signal) => {
      restore();
      process.kill(process.pid, signal);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    let run;
    try {
      fs.writeFileSync(file, original.replace(mutation.before, mutation.after));
      run = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32' });
    } finally {
      restore();
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
    const timedOut = run.error && run.error.code === 'ETIMEDOUT';
    const killed = timedOut || run.status !== 0;
    const result = { name: mutation.name, file: mutation.file, killed, exitCode: run.status, timedOut, output: `${run.stdout || ''}${run.stderr || ''}`.slice(-4000) };
    results.push(result);
    onResult?.(result);
  }
  return { allKilled: results.every((r) => r.killed), results, survivors: results.filter((r) => !r.killed) };
}

function assertMutationsKilled(options) {
  const report = runMutations(options);
  if (!report.allKilled) {
    throw new AssertionError({ message: `${report.survivors.length} mutation(s) survived (no test failed):\n${report.survivors.map((s) => `  - ${s.name} (${s.file})`).join('\n')}` });
  }
  return report;
}

module.exports = { runMutations, assertMutationsKilled };
