'use strict';

const crypto = require('node:crypto');

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Un jeton fabriqué pour un essai : « none » (sans signature), HS256/384/512 avec un secret. Sert à produire des jetons
 * expirés, d'une autre audience ou sans échéance que la vérification doit refuser, avec la bonne signature.
 */
function forgeJwt({ header = {}, payload = {}, secret, alg = header.alg || 'HS256' } = {}) {
  const head = b64({ typ: 'JWT', ...header, alg });
  const body = b64(payload);
  const input = `${head}.${body}`;
  if (alg.toLowerCase() === 'none') return `${input}.`;
  const hash = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }[alg];
  if (!hash) throw new Error(`forgeJwt only signs none and HS256/384/512, not ${alg}.`);
  if (secret === undefined) throw new Error('forgeJwt needs a secret for HMAC algorithms.');
  return `${input}.${crypto.createHmac(hash, secret).update(input).digest('base64url')}`;
}

/**
 * Les variantes d'un jeton valide qu'une vérification doit toutes refuser. `publicKey` (PEM ou KeyObject) ajoute la
 * confusion d'algorithme : le jeton signé en HS256 avec la clé publique comme secret, que certaines bibliothèques
 * acceptaient pour un jeton RS256 ou ES256.
 */
function jwtAttacks(token, { publicKey } = {}) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('jwtAttacks needs a compact JWS (three parts).');
  const [head, body, signature] = parts;
  const header = decodePart(head) || {};
  const payload = decodePart(body) || {};
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  const add = (name, value) => out.push({ name, token: value });

  for (const alg of ['none', 'None', 'NONE', 'nOnE']) {
    add(`alg ${alg}, no signature`, `${b64({ ...header, alg })}.${body}.`);
    add(`alg ${alg}, original signature kept`, `${b64({ ...header, alg })}.${body}.${signature}`);
  }
  add('signature removed', `${head}.${body}.`);
  add('signature removed, no trailing dot', `${head}.${body}`);
  add('empty signature segment then extra segment', `${head}.${body}..`);
  add('signature truncated', `${head}.${body}.${signature.slice(0, Math.max(1, signature.length - 4))}`);
  add('signature one character changed', `${head}.${body}.${flipChar(signature)}`);
  add('signature of zero bytes', `${head}.${body}.${Buffer.alloc(Buffer.from(signature, 'base64url').length).toString('base64url')}`);
  add('signature in standard base64', `${head}.${body}.${Buffer.from(signature, 'base64url').toString('base64')}`);
  add('signature padded with =', `${head}.${body}.${signature}==`);
  add('payload changed, signature kept (role)', `${head}.${b64({ ...payload, role: 'admin', roles: ['admin'], admin: true })}.${signature}`);
  add('payload changed, signature kept (subject)', `${head}.${b64({ ...payload, sub: 'someone-else', id: 'someone-else', userId: 'someone-else' })}.${signature}`);
  add('payload changed, signature kept (expiry)', `${head}.${b64({ ...payload, exp: now + 10 * 365 * 86400 })}.${signature}`);
  add('header changed, signature kept (kid)', `${b64({ ...header, kid: '../../../../dev/null' })}.${body}.${signature}`);
  add('header jku pointing elsewhere', `${b64({ ...header, jku: 'http://127.0.0.1/keys.json' })}.${body}.${signature}`);
  add('header x5u pointing elsewhere', `${b64({ ...header, x5u: 'http://127.0.0.1/cert.pem' })}.${body}.${signature}`);
  add('header with embedded jwk', `${b64({ ...header, jwk: { kty: 'oct', k: b64('attacker') } })}.${body}.${signature}`);
  add('unknown critical header', `${b64({ ...header, crit: ['exp-attack'], 'exp-attack': true })}.${body}.${signature}`);
  add('whitespace around token', ` ${token} `);
  add('Bearer prefix kept', `Bearer ${token}`);
  add('four segments', `${token}.${signature}`);
  add('header not JSON', `${b64('not json')}.${body}.${signature}`);
  add('payload not JSON', `${head}.${b64('not json')}.${signature}`);
  add('payload JSON array', `${head}.${b64([payload])}.${signature}`);
  add('empty token', '');
  add('dots only', '..');
  add('huge token', `${head}.${b64({ ...payload, pad: 'x'.repeat(200_000) })}.${signature}`);

  for (const alg of ['HS256', 'HS384', 'HS512']) {
    add(`${alg} signed with an empty secret`, forgeJwt({ header: { ...header, alg }, payload, secret: '' }));
    add(`${alg} signed with secret "secret"`, forgeJwt({ header: { ...header, alg }, payload, secret: 'secret' }));
  }
  if (publicKey) {
    const pem = typeof publicKey === 'string' ? publicKey : publicKey.export({ type: 'spki', format: 'pem' });
    for (const alg of ['HS256', 'HS384', 'HS512']) {
      add(`algorithm confusion: ${alg} with the public key as secret`, forgeJwt({ header: { ...header, alg }, payload, secret: pem }));
      add(`algorithm confusion: ${alg} with the public key (no trailing newline)`, forgeJwt({ header: { ...header, alg }, payload, secret: pem.trimEnd() }));
    }
  }
  return out;
}

/** Les revendications qu'une vérification doit refuser, à signer avec la vraie clé (expiré, pas encore valable…). */
function jwtClaimAttacks(payload = {}, { audience, issuer } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const base = { ...payload };
  delete base.exp;
  delete base.nbf;
  delete base.iat;
  const out = [
    { name: 'expired', payload: { ...base, iat: now - 7200, exp: now - 3600 } },
    { name: 'expired one second ago', payload: { ...base, iat: now - 60, exp: now - 1 } },
    { name: 'not yet valid (nbf in one hour)', payload: { ...base, iat: now, nbf: now + 3600, exp: now + 7200 } },
    { name: 'issued in the future', payload: { ...base, iat: now + 3600, exp: now + 7200 } },
    { name: 'iat not a number', payload: { ...base, iat: 'now', exp: now + 3600 } },
    { name: 'exp as a string', payload: { ...base, iat: now, exp: String(now + 3600) } },
    { name: 'exp not a number', payload: { ...base, iat: now, exp: 'never' } },
  ];
  const without = (key) => {
    const copy = { ...base, iat: now, exp: now + 3600 };
    delete copy[key];
    return copy;
  };
  if (audience !== undefined) {
    out.push({ name: 'other audience', payload: { ...base, iat: now, exp: now + 3600, aud: `${audience}.other` } });
    out.push({ name: 'audience in a list of others', payload: { ...base, iat: now, exp: now + 3600, aud: [`${audience}.other`] } });
    out.push({ name: 'audience missing', payload: without('aud') });
  }
  if (issuer !== undefined) {
    out.push({ name: 'other issuer', payload: { ...base, iat: now, exp: now + 3600, iss: `${issuer}.other` } });
    out.push({ name: 'issuer missing', payload: without('iss') });
  }
  return out;
}

function flipChar(text) {
  if (!text) return 'A';
  const i = Math.floor(text.length / 2);
  return text.slice(0, i) + (text[i] === 'A' ? 'B' : 'A') + text.slice(i + 1);
}

module.exports = { forgeJwt, jwtAttacks, jwtClaimAttacks, decodeJwtPart: decodePart };
