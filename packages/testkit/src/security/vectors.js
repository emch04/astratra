'use strict';

const { AssertionError } = require('node:assert');
const { isDeepStrictEqual } = require('node:util');
const { describeValue } = require('./describe');

/**
 * Les vecteurs de conformité : des entrées et les résultats exacts publiés avec une norme. Chaque vecteur est
 * `{ id, input, expected }` où `expected` vaut 'valid', 'invalid' (le module doit refuser) ou la valeur attendue ;
 * 'acceptable' (Wycheproof) admet les deux réponses. `run(input)` rend la réponse du module, ou lève pour refuser ;
 * pour 'valid'/'invalid', il peut aussi rendre un booléen (une vérification de signature).
 */
async function runVectors(vectors, run, { equal = isDeepStrictEqual } = {}) {
  if (!Array.isArray(vectors) || typeof run !== 'function') throw new TypeError('runVectors needs a list of vectors and a run function.');
  const failures = [];
  for (const vector of vectors) {
    let outcome;
    try {
      outcome = { ok: true, value: await run(vector.input, vector) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const accepted = outcome.ok && outcome.value !== false;
    let passed;
    if (vector.expected === 'acceptable') passed = true;
    else if (vector.expected === 'valid') passed = accepted;
    else if (vector.expected === 'invalid') passed = !accepted;
    else passed = outcome.ok && equal(outcome.value, vector.expected);
    if (!passed) failures.push({ vector, outcome });
  }
  return { passed: failures.length === 0, total: vectors.length, failures };
}

async function assertVectors(vectors, run, options = {}) {
  const report = await runVectors(vectors, run, options);
  if (!report.passed) {
    const lines = report.failures.slice(0, 20).map(({ vector, outcome }) => {
      const got = outcome.ok ? `answered ${describeValue(outcome.value, 160)}` : `refused (${outcome.error && outcome.error.message})`;
      const want = typeof vector.expected === 'string' && ['valid', 'invalid'].includes(vector.expected) ? vector.expected : describeValue(vector.expected, 160);
      return `  - ${vector.id}${vector.comment ? ` (${vector.comment})` : ''}: expected ${want}, ${got}`;
    });
    throw new AssertionError({ message: `${options.name ? `${options.name}: ` : ''}${report.failures.length} of ${report.total} vector(s) failed${options.source ? ` (${options.source})` : ''}:\n${lines.join('\n')}` });
  }
  return report;
}

/**
 * Un fichier de Project Wycheproof (C2SP, licence Apache-2.0 ; à télécharger depuis le dépôt du projet, il n'est pas
 * recopié ici) changé en vecteurs : chaque test garde son groupe (clé, algorithme) dans `input.group`.
 */
function fromWycheproof(file) {
  if (!file || !Array.isArray(file.testGroups)) throw new TypeError('fromWycheproof needs a parsed Wycheproof JSON file.');
  const out = [];
  for (const group of file.testGroups) {
    const { tests, ...groupFields } = group;
    for (const test of tests || []) {
      out.push({ id: `tcId ${test.tcId}`, comment: [test.comment, ...(test.flags || [])].filter(Boolean).join(', '), input: { ...test, group: groupFields }, expected: test.result });
    }
  }
  return out;
}

/** Quelques vecteurs publiés, recopiés de leurs RFC (les RFC permettent de reprendre leur code et leurs exemples). */
const ascii = (text) => Buffer.from(text, 'ascii');
const standardVectors = {
  /** RFC 4226, annexe D : HOTP sur SHA-1, secret « 12345678901234567890 », six chiffres. */
  hotpRfc4226: ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'].map((code, counter) => ({
    id: `RFC 4226 counter ${counter}`,
    input: { secret: ascii('12345678901234567890'), counter, digits: 6, algorithm: 'sha1' },
    expected: code,
  })),
  /** RFC 6238, annexe B : TOTP, pas de 30 s, huit chiffres, avec SHA-1, SHA-256 et SHA-512. */
  totpRfc6238: (() => {
    const secrets = { sha1: ascii('12345678901234567890'), sha256: ascii('12345678901234567890123456789012'), sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234') };
    const table = [
      [59, { sha1: '94287082', sha256: '46119246', sha512: '90693936' }],
      [1111111109, { sha1: '07081804', sha256: '68084774', sha512: '25091201' }],
      [1111111111, { sha1: '14050471', sha256: '67062674', sha512: '99943326' }],
      [1234567890, { sha1: '89005924', sha256: '91819424', sha512: '93441116' }],
      [2000000000, { sha1: '69279037', sha256: '90698825', sha512: '38618901' }],
      [20000000000, { sha1: '65353130', sha256: '77737706', sha512: '47863826' }],
    ];
    return table.flatMap(([time, codes]) => Object.entries(codes).map(([algorithm, code]) => ({ id: `RFC 6238 ${algorithm} t=${time}`, input: { secret: secrets[algorithm], time, step: 30, digits: 8, algorithm }, expected: code })));
  })(),
  /** RFC 7515, annexe A.1 : un JWS HS256 et sa clé ; la vérification doit l'accepter (sans tenir compte de l'échéance, passée). */
  jwsHs256Rfc7515: [
    {
      id: 'RFC 7515 A.1',
      input: {
        token: 'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        jwk: { kty: 'oct', k: 'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow' },
      },
      expected: 'valid',
    },
  ],
  /**
   * RFC 8291, section 5 et annexe A : un message Web Push chiffré (aes128gcm, RFC 8188). Le chiffrement doit rendre
   * ces octets exactement avec ce sel et cette clé du serveur ; le déchiffrement, avec la clé de l'appareil, le texte.
   */
  webPushRfc8291: [
    {
      id: 'RFC 8291 annexe A',
      input: {
        plaintext: Buffer.from('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', 'base64url'),
        asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
        asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
        uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
        salt: 'DGv6ra1nlYgDCS1FRnbzlw',
        authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
        recordSize: 4096,
      },
      expected: {
        ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
        ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
        cek: 'oIhVW04MRdy2XN9CiKLxTg',
        nonce: '4h_95klXJ5E_qnoN',
        body:
          'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
          'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
      },
    },
  ],
};

module.exports = { runVectors, assertVectors, fromWycheproof, standardVectors };
