'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { checkRegex, assertSafeRegex, attackCandidates, extractRegexLiterals, checkLinearTime, assertLinearTime, bombs, checkBounded, assertBounded } = require('../security');

test('une expression exponentielle est attrapée et son fil arrêté, sans bloquer l’essai', async () => {
  const started = Date.now();
  const report = await checkRegex(/^(a+)+$/);
  assert.equal(report.safe, false);
  assert.equal(report.attack.pump.includes('a'), true);
  assert.ok(Date.now() - started < 10_000);
});

test('une expression quadratique est attrapée sur une longue entrée', async () => {
  const quadratic = await checkRegex(/(\s*,\s*)+x/, { attacks: [{ prefix: '', pump: ' ,', suffix: '!' }] });
  assert.equal(quadratic.safe, false);
});

test('des expressions sûres passent', async () => {
  for (const regex of [/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, /^\d{4}-\d{2}-\d{2}$/, /^[A-Za-z0-9_-]+$/, /\bBearer\s+(\S+)/]) {
    const report = await assertSafeRegex(regex);
    assert.equal(report.safe, true, String(regex));
  }
});

test('le message d’échec décrit l’attaque', async () => {
  await assert.rejects(() => assertSafeRegex(/^(\w+\s?)*$/), (error) => {
    assert.match(error.message, /backtracks on a \d+-character input/);
    assert.match(error.message, /pump/);
    return true;
  });
});

test('les candidats d’attaque viennent des caractères de l’expression', () => {
  const candidates = attackCandidates(/^(x[0-9]+)+$/);
  assert.ok(candidates.some((c) => c.pump.includes('x') || c.pump.includes('9')));
  assert.ok(candidates.every((c) => typeof c.prefix === 'string' && c.pump.length > 0));
});

test('les expressions écrites dans un texte source sont retrouvées', () => {
  const found = extractRegexLiterals("const a = /^(a+)+$/; const b = x / y / z; const c = /[/]\\d+/gi;");
  assert.deepEqual(found.map(String), ['/^(a+)+$/', '/[/]\\d+/gi']);
});

test('une fonction quadratique est vue, une fonction linéaire passe', () => {
  const quadratic = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) for (let j = 0; j < s.length; j++) if (s[i] === s[j]) n++;
    return n;
  };
  const report = checkLinearTime(quadratic, { build: (n) => 'a'.repeat(n), sizes: [1_000, 2_000, 4_000, 8_000], minMs: 1 });
  assert.equal(report.linear, false);
  assertLinearTime((s) => s.split('').reverse().join(''), { build: (n) => 'ab'.repeat(n), sizes: [20_000, 40_000, 80_000, 160_000] });
});

test('les bombes : petites à envoyer, énormes une fois lues', () => {
  const gz = bombs.gzip(64 * 1024 * 1024);
  assert.ok(gz.length < 200_000, `${gz.length} bytes`);
  assert.equal(zlib.gunzipSync(gz.subarray(0, gz.length)).length, 64 * 1024 * 1024);
  const nested = bombs.nestedGzip(16 * 1024 * 1024);
  assert.ok(zlib.gunzipSync(nested).length < 50_000);
  assert.ok(bombs.deflateRaw(8 * 1024 * 1024).length < 20_000);
  assert.ok(bombs.brotli(8 * 1024 * 1024).length < 5_000);
  assert.equal(bombs.deepJsonArray(10).length, 20);
  // JSON.parse de V8 n'est pas récursif ; c'est le code qui parcourt ensuite la valeur qui déborde.
  const walk = (v) => (Array.isArray(v) ? 1 + Math.max(0, ...v.map(walk)) : 0);
  assert.throws(() => walk(JSON.parse(bombs.deepJsonArray(1_000_000))), RangeError);
  assert.equal(Object.keys(JSON.parse(bombs.wideJsonObject(1000))).length, 1000);
  assert.equal(bombs.deepQuery(3), 'a[b][b][b]=1');
  assert.equal(Object.keys(bombs.manyHeaders(10)).length, 10);
});

test('une lecture sans plafond est prise sur le fait, une lecture plafonnée passe', async () => {
  const bomb = bombs.gzip(256 * 1024 * 1024);
  const unbounded = await checkBounded(() => zlib.gunzipSync(bomb), { maxHeapGrowthMB: 64, maxMs: 30_000 });
  assert.equal(unbounded.bounded, false);
  assert.match(unbounded.problems.join(), /memory grew/);
  const capped = await assertBounded(() => zlib.gunzipSync(bomb, { maxOutputLength: 1024 * 1024 }), { maxHeapGrowthMB: 64 });
  assert.equal(capped.refused, true);
});

test('une réponse trop lente dépasse le temps permis', async () => {
  const report = await checkBounded(() => new Promise((resolve) => setTimeout(resolve, 60)), { maxMs: 20 });
  assert.equal(report.bounded, false);
  assert.match(report.problems[0], /took/);
});
