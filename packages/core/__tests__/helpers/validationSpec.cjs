'use strict';

/*
 * Une chaîne de validation décrite en JSON, construite à l'identique avec express-validator (à l'enregistrement) ou avec
 * le module de core (dans les essais). Les fonctions et expressions régulières sont nommées : { $fn: 'nom' },
 * { $re: [source, drapeaux] }, { $chain: description } pour if(chaîne).
 */

const FUNCTIONS = {
  vrai: () => true,
  faux: () => false,
  rienRendu: () => undefined,
  leve: () => {
    throw new Error('refusé par la fonction');
  },
  leveTexte: () => {
    throw 'refus en texte';
  },
  promesseTenue: async () => 'ok',
  promesseRejetee: async () => {
    throw new Error('rejet asynchrone');
  },
  egalMotDePasse: (value, { req }) => value === req.body.password,
  estPair: (value) => Number(value) % 2 === 0,
  majuscules: (value) => (typeof value === 'string' ? value.toUpperCase() : value),
  doubler: (value) => (Array.isArray(value) ? value.concat(value) : value),
  versNombre: async (value) => Number(value),
  messageChemin: (value, meta) => `${meta.location}:${meta.path}=${JSON.stringify(value)}`,
  aRole: (value, { req }) => req.body.role === 'admin',
};

function buildArg(arg, lib) {
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    if (arg.$fn) return FUNCTIONS[arg.$fn];
    if (arg.$re) return new RegExp(arg.$re[0], arg.$re[1]);
    if (arg.$chain) return buildChain(lib, arg.$chain);
    return Object.fromEntries(Object.entries(arg).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => buildArg(x, lib)) : buildArg(v, lib)]));
  }
  return arg;
}

/** La chaîne décrite, avec la bibliothèque donnée ({ body, param, query, header, cookie, check }). */
function buildChain(lib, spec) {
  let chain = lib[spec.location](spec.fields, spec.message && spec.message.$fn ? FUNCTIONS[spec.message.$fn] : spec.message);
  for (const [method, ...args] of spec.steps) chain = chain[method](...args.map((a) => buildArg(a, lib)));
  return chain;
}

/** Une valeur en JSON sans perte : undefined, NaN, ±Infinity et les dates gardés. */
function encode(value) {
  if (value === undefined) return { $u: 1 };
  if (typeof value === 'number' && Number.isNaN(value)) return { $nan: 1 };
  if (value === Infinity || value === -Infinity) return { $inf: Math.sign(value) };
  if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  if (typeof value === 'function') return { $function: 1 };
  return value;
}

/** Lance un cas : toutes ses chaînes, puis les erreurs, la requête nettoyée et les données retenues. */
async function runCase(lib, testCase) {
  const req = JSON.parse(JSON.stringify(testCase.req));
  for (const key of ['body', 'params', 'query', 'headers', 'cookies']) if (!(key in req)) req[key] = {};
  if (testCase.undefinedBody) req.body = undefined;
  let crash = null;
  try {
    for (const spec of testCase.chains) await buildChain(lib, spec).run(req);
  } catch (error) {
    crash = `${error.name}: ${error.message}`;
  }
  const result = lib.validationResult(req);
  return encode({
    crash,
    errors: result.array(),
    firstErrors: result.array({ onlyFirstError: true }),
    mappedKeys: Object.keys(result.mapped()),
    req: { body: req.body, params: req.params, query: req.query, headers: req.headers, cookies: req.cookies },
    matched: lib.matchedData(req),
    matchedAll: lib.matchedData(req, { onlyValidData: false, includeOptionals: true }),
    matchedBody: lib.matchedData(req, { locations: ['body'] }),
  });
}

/**
 * Le résultat réduit pour l'enregistrement : passé par JSON (les trous d'un tableau deviennent null), sans ce qui
 * se déduit (premières erreurs égales aux erreurs, données d'un emplacement égales aux données retenues, requête
 * inchangée, aucun plantage).
 */
function compact(result, testCase) {
  const r = JSON.parse(JSON.stringify(result));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (r.crash === null) delete r.crash;
  if (same(r.firstErrors, r.errors)) delete r.firstErrors;
  if (same(r.mappedKeys, [...new Set(r.errors.map((e) => e.path))])) delete r.mappedKeys;
  if (same(r.matchedBody, r.matched)) delete r.matchedBody;
  if (same(r.matchedAll, r.matched)) delete r.matchedAll;
  const original = JSON.parse(JSON.stringify(encode({ body: testCase.undefinedBody ? undefined : testCase.req.body || {}, params: testCase.req.params || {}, query: testCase.req.query || {}, headers: testCase.req.headers || {}, cookies: testCase.req.cookies || {} })));
  if (same(r.req, original)) delete r.req;
  return r;
}

module.exports = { buildChain, runCase, encode, compact, FUNCTIONS };
