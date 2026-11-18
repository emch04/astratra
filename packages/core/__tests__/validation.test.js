/* global fetch */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { assertVectors, assertFuzz, gen, assertSafeRegex, extractRegexLiterals, assertLinearTime } = require('@astratra/testkit/security');
const core = require('../src');
const { runCase, compact } = require('./helpers/validationSpec.cjs');

const { body, param, query, validationResult, matchedData, validateMiddleware } = core;

// La validation des requêtes sans express-validator (src/validation.js et src/validators.js) : comparée à
// express-validator 7.3 et validator.js 13.15 sur des réponses enregistrées, branchée dans Express, puis attaquée.

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/express-validator-reference.json'), 'utf8'));

describe(`comparé à ${reference.source}`, () => {
  test(`mêmes erreurs, mêmes nettoyages et mêmes données retenues sur ${reference.cases.length} cas, sauf les plantages d’express-validator`, async () => {
    // Écarts voulus : un demi-caractère Unicode (URIError dans validator.js) ou une valeur JSON qui ne se convertit pas
    // en texte ({"toString":0}, TypeError dans express-validator) faisaient planter la requête ; ici la valeur est
    // simplement invalide.
    await assertVectors(reference.cases.map((c) => ({ id: c.id, input: c, expected: c.expected.crash ? 'invalide sans planter' : c.expected })), async (c) => {
      const ours = compact(await runCase(core, c), c);
      if (c.expected.crash) {
        if (/Cannot convert object to primitive value/.test(c.expected.crash)) return !ours.crash ? 'invalide sans planter' : ours;
        if (!/URIError/.test(c.expected.crash)) return `plantage inattendu chez eux : ${c.expected.crash}`;
        return !ours.crash && ours.errors.length > 0 ? 'invalide sans planter' : ours;
      }
      return ours;
    });
  });
});

describe('dans Express', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post('/inscription', body('email').trim().isEmail().normalizeEmail(), body('age').optional().isInt({ min: 13 }).toInt(), (req, res) => {
      const result = validationResult(req);
      if (!result.isEmpty()) return res.status(400).json({ errors: result.array() });
      return res.json({ data: matchedData(req) });
    });
    app.patch('/reglages/:key', validateMiddleware([param('key').trim().notEmpty().isLength({ max: 200 }), body('value').exists().withMessage('value is required')]), (req, res) => res.json({ key: req.params.key, value: req.body.value }));
    // Express 5 recalcule req.query à chaque lecture : un nettoyage ne s'y écrit pas (ni avec express-validator) ; la
    // valeur nettoyée se lit dans matchedData.
    app.get('/liste', query('page').default('1').isInt({ min: 1 }).toInt(), (req, res) => res.json({ page: matchedData(req).page, errors: validationResult(req).array() }));
    server = http.createServer(app);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((ok) => server.close(ok)));
  const send = async (method, url, data) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  };

  test('une chaîne sert de middleware : nettoie, valide et retient les données', async () => {
    expect(await send('POST', '/inscription', { email: '  Jean.Dupont+promo@Gmail.com ', age: '30', extra: 'ignoré' })).toEqual({ status: 200, body: { data: { email: 'jeandupont@gmail.com', age: 30 } } });
    const refused = await send('POST', '/inscription', { email: 'pas une adresse', age: '9' });
    expect(refused.status).toBe(400);
    expect(refused.body.errors.map((e) => [e.path, e.location])).toEqual([['email', 'body'], ['age', 'body']]);
  });

  test('validateMiddleware répond 400 avec les erreurs, et laisse passer une requête valide', async () => {
    expect(await send('PATCH', '/reglages/%20theme%20', { value: 'sombre' })).toEqual({ status: 200, body: { key: 'theme', value: 'sombre' } });
    const refused = await send('PATCH', '/reglages/theme', {});
    expect(refused.status).toBe(400);
    expect(refused.body.data.errors).toEqual([{ type: 'field', msg: 'value is required', path: 'value', location: 'body' }]);
  });

  test('une valeur par défaut est retenue (matchedData)', async () => {
    expect((await send('GET', '/liste')).body).toEqual({ page: 1, errors: [] });
    expect((await send('GET', '/liste?page=0')).body.errors).toHaveLength(1);
  });
});

describe('attaques', () => {
  test('pollution de prototype : ni un chemin, ni un joker, ni matchedData n’écrivent sur un prototype', async () => {
    const req = { body: JSON.parse('{"items":{"__proto__":{"name":" a "},"ok":{"name":" b "}},"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}'), params: {}, query: {}, headers: {}, cookies: {} };
    for (const chain of [body('items.*.name').trim().default('pollué'), body('__proto__.admin').default(true), body('constructor.prototype.polluted').default('oui'), body('prototype').default('oui'), body('a.__proto__.b').default('oui')]) await chain.run(req);
    matchedData(req, { includeOptionals: true, onlyValidData: false });
    const named = await body('items.*.name').notEmpty().run(req);
    expect(named.array().map((e) => e.path)).toEqual([]); // la clé « __proto__ » n'est pas un champ : aucune erreur à son nom
    expect((await body('__proto__.admin').exists().run(req)).array()).toHaveLength(1);
    expect({}.admin).toBeUndefined();
    expect({}.polluted).toBeUndefined();
    expect({}.name).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
    expect(req.body.items.ok.name).toBe('b');
    expect(Object.getPrototypeOf(req.body)).toBe(Object.prototype);
  });

  test('une propriété héritée n’est jamais lue comme une valeur envoyée', async () => {
    const req = { body: {}, params: {}, query: {}, headers: {}, cookies: {} };
    const result = await body('toString').exists().run(req);
    expect(result.array()).toEqual([{ type: 'field', value: undefined, msg: 'Invalid value', path: 'toString', location: 'body' }]);
  });

  test('le fuzz : un corps quelconque, avec chaque vérification, donne un résultat, jamais un plantage', async () => {
    const chains = () => [
      body('email').trim().isEmail().normalizeEmail(),
      body('n').optional({ values: 'falsy' }).isInt({ min: 0, max: 10 }).toInt(),
      body('list.*.name').trim().notEmpty().isLength({ max: 20 }).escape(),
      body('id').isMongoId(),
      body('ip').isIP(),
      body('host').isFQDN(),
      body('f').isFloat({ locale: 'fr-FR' }).toFloat(),
      body('u').isUUID(),
      body('b').isBoolean().toBoolean(),
      body('d').toDate(),
      body('s').isString().matches(/^[a-z]+$/i).isIn(['a', 'b']),
    ];
    const generator = gen.record({ email: gen.hostileString(), n: gen.json(), list: gen.array(gen.record({ name: gen.oneOf(gen.hostileString(), gen.json()) }), { max: 4 }), id: gen.hostileString(), ip: gen.hostileString(), host: gen.hostileString(), f: gen.hostileString(), u: gen.json(), b: gen.json(), d: gen.hostileString(), s: gen.oneOf(gen.hostileString(), gen.json()) });
    await assertFuzz(async (bodyValue) => {
      const req = { body: JSON.parse(JSON.stringify(bodyValue)), params: {}, query: {}, headers: {}, cookies: {} };
      for (const chain of chains()) await chain.run(req);
      return validationResult(req).array();
    }, { generator, runs: 600 });
  });

  test('pas de temps qui explose sur une longue entrée hostile (adresses, domaines, IP, longueurs)', () => {
    const { validators } = require('../src/validators');
    assertLinearTime((s) => validators.isEmail(s), { build: (n) => `${'a.'.repeat(n)}@${'b-'.repeat(n)}`, name: 'isEmail' });
    assertLinearTime((s) => validators.isFQDN(s), { build: (n) => `${'a-'.repeat(n)}.com`, name: 'isFQDN' });
    assertLinearTime((s) => validators.isIP(s), { build: (n) => `${'1:'.repeat(n)}x`, name: 'isIP' });
    assertLinearTime((s) => validators.isLength(s, { max: 5 }), { build: (n) => '👍🏽'.repeat(n), name: 'isLength' });
  });

  test('aucune expression régulière littérale ne s’emballe', async () => {
    for (const file of ['validation.js', 'validators.js']) {
      for (const regex of extractRegexLiterals(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'))) await assertSafeRegex(regex);
    }
  });

  test('erreurs de construction claires : withMessage sans validateur, condition invalide, champ non textuel', () => {
    expect(() => body('x').withMessage('m')).toThrow(/must follow a validator/);
    expect(() => body('x').if(42)).toThrow(/condition/);
    expect(() => body(42)).toThrow(/field/);
    expect(() => body('x').custom('pas une fonction')).toThrow(/function/);
    expect(typeof body('x').isURL).toBe('undefined');
  });
});
