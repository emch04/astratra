'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  measureTiming, checkConstantTime, assertConstantTime, welchT,
  captureOutput, findSecrets, assertNoSecrets,
  checkAuthorizationMatrix, assertAuthorizationMatrix, assertNoCrossAccountAccess,
  race, assertAtMost, faults, withFault, assertFailsClosed,
  runMutations, assertMutationsKilled,
  checkLockfile, assertLockfile, checkDependencyAllowlist, assertDependencyAllowlist,
} = require('../security');

test('le test t de Welch : zéro pour deux séries égales, grand pour deux séries décalées', () => {
  assert.equal(welchT([1, 2, 3, 4], [1, 2, 3, 4]), 0);
  assert.ok(Math.abs(welchT([10, 11, 10, 11, 10, 11], [1, 2, 1, 2, 1, 2])) > 10);
});

test('une comparaison qui s’arrête au premier octet faux trahit le secret ; timingSafeEqual non', () => {
  const secret = crypto.randomBytes(4096);
  const early = Buffer.from(secret);
  early[0] ^= 1; // faux dès le premier octet
  const late = Buffer.from(secret);
  late[late.length - 1] ^= 1; // faux seulement au dernier
  const leaky = (candidate) => {
    for (let i = 0; i < secret.length; i++) if (candidate[i] !== secret[i]) return false;
    return true;
  };
  const report = checkConstantTime(leaky, { classes: [() => early, () => late], samples: 2_000, attempts: 2 });
  assert.equal(report.constant, false, `|t| = ${report.runs.map((r) => r.absT.toFixed(1)).join(', ')}`);
  assert.throws(() => assertConstantTime(leaky, { classes: [() => early, () => late], samples: 2_000, attempts: 2, name: 'comparaison naïve' }), /comparaison naïve: timing depends on the input/);
  const safe = (candidate) => crypto.timingSafeEqual(candidate, secret);
  const safeReport = checkConstantTime(safe, { classes: [() => early, () => late], samples: 2_000, attempts: 5 });
  assert.equal(safeReport.constant, true, `|t| = ${safeReport.runs.map((r) => r.absT.toFixed(1)).join(', ')}`);
  const measured = measureTiming(safe, { classes: [() => early, () => late], samples: 500 });
  assert.ok(Number.isFinite(measured.t));
});

test('la capture prend process.stdout, process.stderr et console, puis remet tout en place', async () => {
  const before = process.stdout.write;
  const { output, result } = await captureOutput(async () => {
    console.log('un %s', 'journal');
    console.error('une erreur');
    process.stdout.write('direct\n');
    process.stderr.write(Buffer.from('octets\n'));
    return 42;
  });
  assert.equal(result, 42);
  for (const line of ['un journal', 'une erreur', 'direct', 'octets']) assert.match(output, new RegExp(line));
  assert.equal(process.stdout.write, before);
  const failed = await captureOutput(() => {
    throw new Error('boum');
  });
  assert.equal(failed.error.message, 'boum');
});

test('un secret connu est retrouvé sous ses autres écritures, et les formes de secrets sont reconnues', () => {
  const secret = 'S3cr3t-Valeur-Tres-Longue-123456';
  const text = [
    `jeton=${Buffer.from(secret).toString('base64')}`,
    `hex ${Buffer.from(secret).toString('hex')}`,
    `debut ${secret.slice(0, 16)}`,
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    'postgres://app:motdepasse@db.example.test/app',
    '-----BEGIN PRIVATE KEY-----',
    '{"password":"hunter2hunter2"}',
    'carte 4242 4242 4242 4242',
    `sk_${'live'}_${'a'.repeat(24)}`,
  ].join('\n');
  const findings = findSecrets(text, { secrets: [secret] });
  const kinds = findings.map((f) => `${f.kind}${f.encoding ? `:${f.encoding}` : ''}`);
  for (const kind of ['known secret:base64', 'known secret:hex', 'known secret:first 16 characters', 'Bearer token', 'credentials in a URL', 'private key', 'password field', 'card number', 'Stripe key']) assert.ok(kinds.includes(kind), `${kind} in ${kinds}`);
  // Le message d'échec ne recopie jamais le secret entier.
  assert.throws(() => assertNoSecrets(text, { secrets: [secret] }), (error) => !error.message.includes(secret) && /secret\(s\) found/.test(error.message));
  assert.doesNotThrow(() => assertNoSecrets('rien à signaler, identifiant 123', { secrets: [secret] }));
  assert.equal(findSecrets('4242 4242 4242 4241').length, 0); // clé de Luhn fausse
  assert.equal(findSecrets('Bearer [REDACTED-TOKEN-VALUE-0000]', { allow: ['[REDACTED'] }).length, 0);
});

test('la matrice d’autorisations trouve la fiche lisible par un autre compte (IDOR)', async () => {
  const notes = { 'note-alice': { owner: 'alice' }, 'note-bob': { owner: 'bob' } };
  const vulnerable = ({ context, action, target }) => {
    if (!context) return 401;
    if (action === 'read') return 200; // oublie de vérifier le propriétaire en lecture
    return target.owner === context.user ? 200 : 403;
  };
  const options = {
    actors: { anonyme: null, alice: { user: 'alice' }, bob: { user: 'bob' } },
    actions: ['read', 'update', 'delete'],
    resources: { 'note-alice': notes['note-alice'], 'note-bob': notes['note-bob'] },
    expected: ({ actor, target }) => (actor !== 'anonyme' && target.owner === actor ? 'allow' : 'deny'),
  };
  const report = await checkAuthorizationMatrix({ ...options, attempt: vulnerable });
  assert.equal(report.cells.length, 18);
  assert.deepEqual(report.tooOpen.map((c) => `${c.actor}:${c.action}:${c.resource}`).sort(), ['alice:read:note-bob', 'bob:read:note-alice']);
  await assert.rejects(() => assertAuthorizationMatrix({ ...options, attempt: vulnerable, name: 'notes' }), /notes: authorization matrix: 2 of 18 cell\(s\) wrong\.\nALLOWED BUT SHOULD BE DENIED/);
  const fixed = ({ context, target }) => (!context ? 401 : target.owner === context.user ? 200 : 404);
  await assertAuthorizationMatrix({ ...options, attempt: fixed });
  await assertNoCrossAccountAccess({ owner: { user: 'alice' }, intruder: { user: 'bob' }, resources: { 'note-alice': notes['note-alice'] }, attempt: fixed });
  await assert.rejects(() => checkAuthorizationMatrix({ ...options, expected: () => 'maybe', attempt: fixed }), /must return "allow" or "deny"/);
});

test('la course trouve la dernière place vendue deux fois ; un verrou l’empêche', async () => {
  const pause = () => new Promise((resolve) => setImmediate(resolve));
  let seats = 1;
  const naive = async () => {
    if (seats > 0) {
      await pause(); // le temps d'une requête à la base
      seats -= 1;
      return { status: 201 };
    }
    return { status: 409 };
  };
  await assert.rejects(() => assertAtMost(naive, { concurrency: 20, name: 'dernière place' }), /dernière place: \d+ of 20 concurrent attempts succeeded/);
  seats = 1;
  let chain = Promise.resolve();
  const locked = () => {
    const run = chain.then(async () => {
      if (seats <= 0) return { status: 409 };
      await pause();
      seats -= 1;
      return { status: 201 };
    });
    chain = run.catch(() => {});
    return run;
  };
  const result = await assertAtMost(locked, { concurrency: 20 });
  assert.equal(result.successes.length, 1);
  const raw = await race(async (i) => {
    if (i === 3) throw new Error('x');
    return i;
  }, { concurrency: 5 });
  assert.equal(raw.failed.length, 1);
});

test('une limite qui s’ouvre quand son magasin tombe est attrapée ; la méthode est remise après', async () => {
  const store = { async increment() { return 1; } };
  const failsOpen = async () => {
    try {
      const hits = await store.increment('ip');
      return hits > 5 ? { status: 429 } : { status: 200 };
    } catch {
      return { status: 200 }; // laisse passer quand le magasin tombe
    }
  };
  const failsClosed = async () => {
    try {
      const hits = await store.increment('ip');
      return hits > 5 ? { status: 429 } : { status: 200 };
    } catch {
      return { status: 503 };
    }
  };
  const original = store.increment;
  await assert.rejects(() => assertFailsClosed(store, 'increment', faults.rejecting(), failsOpen, { name: 'limite' }), /limite: allowed while increment was failing \(fails open\)/);
  assert.equal(store.increment, original);
  await assertFailsClosed(store, 'increment', faults.rejecting(), failsClosed);
  await assertFailsClosed(store, 'increment', faults.returning(Promise.resolve(99)), failsOpen);
  const delayed = await withFault(store, 'increment', faults.delayed(5), () => store.increment());
  assert.equal(delayed, 1);
  let flakyErrors = 0;
  await withFault(store, 'increment', faults.flaky(2), async () => {
    for (let i = 0; i < 4; i++) {
      try {
        await store.increment();
      } catch {
        flakyErrors += 1;
      }
    }
  });
  assert.equal(flakyErrors, 2);
  assert.throws(() => faults.throwing()(), /connection refused/);
  await assert.rejects(() => withFault(store, 'absent', faults.throwing(), () => {}), /not a method/);
});

test('les mutations : une vérification retirée est tuée par l’essai, une ligne non testée survit, le fichier est remis', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astratra-mutation-'));
  try {
    fs.writeFileSync(path.join(dir, 'garde.js'), "module.exports = (role) => role === 'admin';\nmodule.exports.note = () => 'jamais testée';\n");
    fs.writeFileSync(path.join(dir, 'garde.test.js'), "const assert = require('node:assert');\nconst garde = require('./garde');\nassert.equal(garde('admin'), true);\nassert.equal(garde('membre'), false);\n");
    const command = [process.execPath, ['garde.test.js']];
    const cases = [
      { name: 'garde toujours ouverte', file: 'garde.js', before: "role === 'admin'", after: 'true' },
      { name: 'note changée', file: 'garde.js', before: "'jamais testée'", after: "'autre'" },
    ];
    const report = runMutations({ cwd: dir, cases, command });
    assert.deepEqual(report.results.map((r) => [r.name, r.killed]), [['garde toujours ouverte', true], ['note changée', false]]);
    assert.match(fs.readFileSync(path.join(dir, 'garde.js'), 'utf8'), /role === 'admin'/);
    assert.throws(() => assertMutationsKilled({ cwd: dir, cases, command }), /1 mutation\(s\) survived/);
    assert.throws(() => runMutations({ cwd: dir, cases: [{ name: 'absente', file: 'garde.js', before: 'introuvable', after: 'x' }], command }), /appears 0 time/);
    fs.writeFileSync(path.join(dir, 'garde.test.js'), 'process.exit(1);\n');
    assert.throws(() => runMutations({ cwd: dir, cases: cases.slice(0, 1), command }), /already fail without any mutation/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('le verrou npm : registre, empreinte et scripts d’installation sont contrôlés', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/bon': { version: '1.0.0', resolved: 'https://registry.npmjs.org/bon/-/bon-1.0.0.tgz', integrity: 'sha512-abc' },
      'node_modules/ailleurs': { version: '1.0.0', resolved: 'https://registre.example.test/ailleurs.tgz', integrity: 'sha512-abc' },
      'node_modules/git': { version: '1.0.0', resolved: 'git+ssh://git@example.test/x.git#abc' },
      'node_modules/faible': { version: '1.0.0', resolved: 'https://registry.npmjs.org/faible/-/faible-1.0.0.tgz', integrity: 'sha1-abc' },
      'node_modules/script': { version: '1.0.0', resolved: 'https://registry.npmjs.org/script/-/script-1.0.0.tgz', integrity: 'sha512-abc', hasInstallScript: true },
      'node_modules/natif': { version: '1.0.0', resolved: 'https://registry.npmjs.org/natif/-/natif-1.0.0.tgz', integrity: 'sha512-abc', hasInstallScript: true },
      'packages/lien': { link: true, resolved: 'packages/lien' },
    },
  };
  const report = checkLockfile(lock, { allowInstallScripts: ['natif'] });
  const problems = report.problems.map((p) => `${p.name}: ${p.problem}`);
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('ailleurs: comes from https://registre.example.test')));
  assert.ok(problems.some((p) => p === 'git: no integrity hash'));
  assert.ok(problems.some((p) => p === 'faible: weak integrity hash (sha1)'));
  assert.ok(problems.some((p) => p === 'script: runs a script at install time'));
  assert.throws(() => assertLockfile(lock), /lockfile: 6 problem\(s\)/);
});

test('la liste des dépendances permises refuse une dépendance arrivée en passant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astratra-deps-'));
  try {
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ dependencies: { express: '^5', 'left-pad': '1', '@astratra/core': '1' }, devDependencies: { jest: '30' } }));
    const report = checkDependencyAllowlist({ packageJsons: [file], allowed: { express: 'serveur HTTP', pg: 'PostgreSQL' }, ignore: [/^@astratra\//] });
    assert.deepEqual(report.unexpected.map((u) => u.name), ['left-pad']);
    assert.deepEqual(report.unused, ['pg']);
    assert.throws(() => assertDependencyAllowlist({ packageJsons: [file], allowed: ['express'], ignore: [/^@astratra\//] }), /left-pad \(dependencies of/);
    assert.equal(checkDependencyAllowlist({ packageJsons: [file], allowed: ['express', 'left-pad', 'jest'], includeDev: true, ignore: [/^@astratra\//] }).passed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
