const { createMongoSanitizeMiddleware } = require('../src');

function runMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    middleware(req, {}, (error) => (error ? reject(error) : resolve()));
  });
}

describe('createMongoSanitizeMiddleware', () => {
  test('strips a top-level $ operator key from req.query', async () => {
    const req = { query: { date: { $gt: '' } }, body: {}, params: {} };
    await runMiddleware(createMongoSanitizeMiddleware(), req);

    expect(req.query.date).toEqual({});
  });

  test('strips a dotted key', async () => {
    const req = { query: {}, body: { 'services.0.date': '2026-01-01' }, params: {} };
    await runMiddleware(createMongoSanitizeMiddleware(), req);

    expect(req.body).toEqual({});
  });

  test('recurses into nested objects and arrays', async () => {
    const req = {
      body: { filters: [{ ok: 'value' }, { $where: 'sabotage' }] },
      query: {},
      params: {}
    };
    await runMiddleware(createMongoSanitizeMiddleware(), req);

    expect(req.body.filters).toEqual([{ ok: 'value' }, {}]);
  });

  test('leaves ordinary requests completely untouched', async () => {
    const req = {
      query: { date: '2026-08-20', serviceIds: ['a', 'b'] },
      body: { nom: 'Jo', note: 5 },
      params: { id: 'abc123' }
    };
    const before = JSON.parse(JSON.stringify(req));
    await runMiddleware(createMongoSanitizeMiddleware(), req);

    expect(req).toEqual(before);
  });

  test('mutates req.query in place rather than reassigning it (getter-only safe)', async () => {
    const query = { date: { $ne: null } };
    const req = {
      body: {}, params: {},
      get query() { return query; }
      // no setter — reassigning req.query would throw; mutating query itself must not.
    };

    await expect(runMiddleware(createMongoSanitizeMiddleware(), req)).resolves.toBeUndefined();
    expect(query.date).toEqual({});
  });

  test('replaceWith keeps the offending value under a renamed key instead of dropping it', async () => {
    const req = { query: { date: { $gt: '' } }, body: {}, params: {} };
    await runMiddleware(createMongoSanitizeMiddleware({ replaceWith: '_blocked' }), req);

    expect(req.query.date).toEqual({ _blocked: '' });
  });

  test('only sanitizes the configured targets', async () => {
    const req = { query: { $where: 'x' }, body: { $where: 'y' }, params: {} };
    await runMiddleware(createMongoSanitizeMiddleware({ targets: ['query'] }), req);

    expect(req.query).toEqual({});
    expect(req.body).toEqual({ $where: 'y' });
  });

  test('calls next() exactly once and never throws on missing targets', async () => {
    const req = {};
    await expect(runMiddleware(createMongoSanitizeMiddleware(), req)).resolves.toBeUndefined();
  });
});

describe('createMongoSanitizeMiddleware with a real Express app', () => {
  const express = require('express');
  const request = require('supertest');
  const version = require('express/package.json').version;

  /* Express 5 relit req.query depuis l'adresse à chaque accès : un nettoyage
     fait en place sur l'objet rendu une première fois était perdu. */
  test('a query getter that parses again on every read still yields the cleaned query', async () => {
    const parse = () => ({ date: { $gt: '2020' }, ok: '1', 'a.b': '2' });
    const proto = { get query() { return parse(); } };
    const req = Object.assign(Object.create(proto), { body: {}, params: {} });
    await runMiddleware(createMongoSanitizeMiddleware(), req);
    expect(req.query).toEqual({ date: {}, ok: '1' });
    expect(req.query).toBe(req.query);
  });

  test.each(['extended', 'simple'])(`Express ${version}, query parser %s: no $ operator and no dotted key reaches the route`, async (parser) => {
    const app = express();
    app.set('query parser', parser);
    app.use(express.json());
    app.use(createMongoSanitizeMiddleware());
    app.get('/x', (req, res) => res.json({ first: req.query, second: req.query }));
    app.post('/x', (req, res) => res.json(req.body));
    const q = await request(app).get('/x?date[$gt]=2020&ok=1&a.b=2&tag[$ne]=x');
    for (const seen of [q.body.first, q.body.second]) {
      expect(JSON.stringify(seen)).not.toMatch(/"\$|"a\.b"/);
      expect(seen.ok).toBe('1');
    }
    const b = await request(app).post('/x').send({ date: { $gt: '2020' }, ok: 1, 'a.b': 2 });
    expect(b.body).toEqual({ date: {}, ok: 1 });
  });
});
