const { createWafMiddleware } = require('../src');

const createRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('waf', () => {
  test.each([
    ['SQL injection', { path: '/users', query: { q: 'select * from users' }, body: {} }],
    ['XSS', { path: '/search', query: {}, body: { name: '<script>alert(1)</script>' } }],
    ['path traversal', { path: '/files/../../../../etc/passwd', query: {}, body: {} }]
  ])('blocks %s patterns', (name, req) => {
    const res = createRes();
    const next = jest.fn();

    createWafMiddleware()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows normal requests', () => {
    const req = { path: '/users', query: { q: 'alice' }, body: { active: true } };
    const next = jest.fn();

    createWafMiddleware()(req, createRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('uses custom message when blocked', () => {
    const res = createRes();

    createWafMiddleware({ message: { error: 'denied' } })(
      { path: '/x', query: {}, body: { value: 'javascript:alert(1)' } },
      res,
      jest.fn()
    );

    expect(res.json).toHaveBeenCalledWith({ error: 'denied' });
  });

  // Régression : monté avant express.json(), req.body vaut undefined et le
  // middleware inspectait silencieusement une chaîne vide à la place du corps
  // réel — une injection dans le body n'était jamais détectée, sans la moindre
  // erreur pour le signaler. Trouvé en testant manuellement une vraie requête,
  // pas par ce fichier de tests : d'où ces deux cas.
  describe('req.body non parsé (mauvais ordre des middlewares)', () => {
    test("laisse passer une requete meme avec un payload dangereux dans le body, mais avertit", () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development'; // le logger est un no-op en 'test'

      const req = { path: '/contact', query: {}, body: undefined, headers: { 'content-length': '42' } };
      const next = jest.fn();

      createWafMiddleware()(req, createRes(), next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/express\.json|body-parser|undefined/i);

      process.env.NODE_ENV = originalEnv;
      warnSpy.mockRestore();
    });

    test("n'avertit qu'une seule fois par instance, pas a chaque requete", () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const middleware = createWafMiddleware();
      for (let i = 0; i < 5; i++) {
        middleware({ path: '/x', query: {}, body: undefined, headers: { 'transfer-encoding': 'chunked' } }, createRes(), jest.fn());
      }

      expect(warnSpy).toHaveBeenCalledTimes(1);

      process.env.NODE_ENV = originalEnv;
      warnSpy.mockRestore();
    });

    test('une requete sans corps (Express 5 laisse alors req.body a undefined) ne declenche aucun avertissement', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const middleware = createWafMiddleware();
      for (const headers of [undefined, {}, { 'content-length': '0' }]) {
        middleware({ path: '/x', query: {}, body: undefined, headers }, createRes(), jest.fn());
      }

      expect(warnSpy).not.toHaveBeenCalled();

      process.env.NODE_ENV = originalEnv;
      warnSpy.mockRestore();
    });

    test('un body correctement parse ne declenche aucun avertissement', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      createWafMiddleware()({ path: '/x', query: {}, body: {} }, createRes(), jest.fn());

      expect(warnSpy).not.toHaveBeenCalled();

      process.env.NODE_ENV = originalEnv;
      warnSpy.mockRestore();
    });
  });
});

describe('createWafMiddleware with a real Express app', () => {
  const express = require('express');
  const request = require('supertest');
  const version = require('express/package.json').version;

  test(`Express ${version}: mounted after express.json(), it warns for nothing, GET or POST, and still blocks an injected body`, async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const app = express();
      app.use(express.json());
      app.use(createWafMiddleware());
      app.all('/x', (req, res) => res.json({ ok: true }));
      expect((await request(app).get('/x')).status).toBe(200);
      expect((await request(app).post('/x').send({ nom: 'Jo' })).status).toBe(200);
      expect((await request(app).post('/x').send({ nom: "' OR 1=1 --" })).status).toBe(403);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
      warnSpy.mockRestore();
    }
  });

  test(`Express ${version}: mounted BEFORE express.json(), a request with a body warns once`, async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const app = express();
      app.use(createWafMiddleware());
      app.use(express.json());
      app.all('/x', (req, res) => res.json({ ok: true }));
      await request(app).get('/x');
      expect(warnSpy).not.toHaveBeenCalled();
      await request(app).post('/x').send({ nom: 'Jo' });
      await request(app).post('/x').send({ nom: 'Jo' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = originalEnv;
      warnSpy.mockRestore();
    }
  });
});
