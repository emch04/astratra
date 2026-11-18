'use strict';

const { AssertionError } = require('node:assert');
const { format } = require('node:util');

/**
 * Les fuites dans les journaux : tout ce que `run` écrit (process.stdout, process.stderr, console.*) est capturé,
 * puis cherché pour les secrets connus (sous leurs écritures courantes : brut, base64, hexadécimal, encodé pour une
 * adresse, échappé en JSON, début seul) et pour les formes de secrets reconnaissables (jetons, clés privées…).
 */
async function captureOutput(run, { passThrough = false } = {}) {
  const chunks = [];
  const originals = { out: process.stdout.write, err: process.stderr.write };
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir'];
  const savedConsole = Object.fromEntries(consoleMethods.map((m) => [m, console[m]]));
  const writer = (stream, original) =>
    function write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      if (passThrough) return original.call(stream, chunk, encoding, callback);
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return true;
    };
  process.stdout.write = writer(process.stdout, originals.out);
  process.stderr.write = writer(process.stderr, originals.err);
  // Jest remplace console par la sienne, qui n'écrit pas dans process.stdout : console est capturée à part.
  for (const method of consoleMethods) {
    console[method] = (...args) => {
      chunks.push(`${format(...args)}\n`);
      if (passThrough) savedConsole[method].apply(console, args);
    };
  }
  let result;
  let error;
  try {
    result = await run();
  } catch (caught) {
    error = caught;
  } finally {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
    for (const method of consoleMethods) console[method] = savedConsole[method];
  }
  return { output: chunks.join(''), result, error };
}

const DEFAULT_PATTERNS = [
  { kind: 'JSON Web Token', pattern: /eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{16,}/g },
  { kind: 'Bearer token', pattern: /\bBearer\s+[\w.~+/-]{16,}=*/gi },
  { kind: 'private key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Stripe key', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { kind: 'Stripe webhook secret', pattern: /\bwhsec_[0-9A-Za-z]{16,}\b/g },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'GitHub token', pattern: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/g },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },
  { kind: 'credentials in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{3,}@/gi },
  { kind: 'password field', pattern: /["']?(?:password|passwd|mot_de_passe|motDePasse|secret|apiKey|api_key|token|refreshToken|refresh_token)["']?\s*[:=]\s*["'][^"'\s]{4,}["']/gi },
  { kind: 'Authorization header', pattern: /\bauthorization["']?\s*[:=]\s*["']?(?!\[)[^\s"',}]{12,}/gi },
];

/** Des numéros de carte (13 à 19 chiffres) dont la clé de Luhn est juste. */
function cardNumbers(text) {
  const out = [];
  for (const match of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) out.push(match[0]);
  }
  return out;
}

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function encodings(secret) {
  const s = String(secret);
  const buffer = Buffer.from(s);
  const forms = [
    ['as is', s],
    ['base64', buffer.toString('base64').replace(/=+$/, '')],
    ['base64url', buffer.toString('base64url')],
    ['hex', buffer.toString('hex')],
    ['URL-encoded', encodeURIComponent(s)],
    ['JSON-escaped', JSON.stringify(s).slice(1, -1)],
  ];
  // Un journal qui coupe le secret le laisse fuir quand même : son début suffit souvent (jetons, clés).
  if (s.length >= 24) forms.push(['first 16 characters', s.slice(0, 16)]);
  return forms.filter(([, form], i, all) => form.length >= 6 && all.findIndex(([, f]) => f === form) === i);
}

function findSecrets(text, { secrets = [], patterns = DEFAULT_PATTERNS, allow = [] } = {}) {
  const findings = [];
  const output = String(text);
  for (const secret of secrets) {
    if (secret === undefined || secret === null || String(secret).length < 6) continue;
    for (const [encoding, form] of encodings(secret)) {
      if (output.includes(form)) findings.push({ kind: 'known secret', encoding, excerpt: mask(form) });
    }
  }
  for (const { kind, pattern } of patterns) {
    for (const match of output.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
      if (allow.some((a) => (a instanceof RegExp ? a.test(match[0]) : match[0].includes(a)))) continue;
      findings.push({ kind, excerpt: mask(match[0]) });
    }
  }
  for (const card of cardNumbers(output)) if (!allow.some((a) => (a instanceof RegExp ? a.test(card) : card.includes(a)))) findings.push({ kind: 'card number', excerpt: mask(card) });
  return findings;
}

function assertNoSecrets(text, options = {}) {
  const findings = findSecrets(text, options);
  if (findings.length) {
    throw new AssertionError({ message: `${options.name ? `${options.name}: ` : ''}${findings.length} secret(s) found in the output:\n${findings.slice(0, 20).map((f) => `  - ${f.kind}${f.encoding ? ` (${f.encoding})` : ''}: ${f.excerpt}`).join('\n')}` });
  }
}

/** Montre assez pour reconnaître la fuite, jamais le secret entier (le message d'échec est lui-même un journal). */
const mask = (value) => (value.length <= 8 ? `${value[0]}…` : `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`);

module.exports = { captureOutput, findSecrets, assertNoSecrets, DEFAULT_SECRET_PATTERNS: DEFAULT_PATTERNS };
