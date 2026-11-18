const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const redisTest = process.env.REDIS_TEST_URL ? test : test.skip;
const outageTest = process.env.REDIS_TEST_URL && process.env.REDIS_TEST_CONTAINER ? test : test.skip;

// The store owns its connection without exposing it. Isolate it in a process
// so that even a failed assertion cannot leave a connection alive in the runner.
const run = (script) => promisify(execFile)(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '..'), timeout: 40000, env: process.env });

const waitForRedis = `
  async function waitForRedis(store, client, prefix, label) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await store.increment(label);
      if ((await client.keys(prefix + '*')).length) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Store must reach Redis');
  }
`;

redisTest('real Redis counters are shared across two stores, with hashed keys', async () => {
  await run(`
    const assert = require('node:assert/strict');
    const { randomUUID, createHash } = require('node:crypto');
    const { createClient } = require('redis');
    const { createRedisRateLimitStore } = require('./src');
    ${waitForRedis}
    (async () => {
      const client = createClient({ url: process.env.REDIS_TEST_URL });
      client.on('error', () => {}); await client.connect();
      const prefix = 'integration:' + randomUUID() + ':';
      const a = createRedisRateLimitStore({ redisUrl: process.env.REDIS_TEST_URL, prefix });
      const b = createRedisRateLimitStore({ redisUrl: process.env.REDIS_TEST_URL, prefix });
      a.init({ windowMs: 1000 }); b.init({ windowMs: 1000 });
      try {
        await waitForRedis(a, client, prefix, 'probe-a');
        await waitForRedis(b, client, prefix, 'probe-b');
        const results = await Promise.all([a.increment('user@example.test'), b.increment('user@example.test')]);
        assert.deepEqual(results.map((r) => r.totalHits).sort(), [1, 2]);
        const hashed = prefix + createHash('sha256').update('user@example.test').digest('hex');
        assert.equal(await client.get(hashed), '2');
        assert.equal((await client.keys(prefix + '*user*')).length, 0, 'no clear-text identifier in Redis');
        const ttl = await client.pTTL(hashed);
        assert.ok(ttl > 0 && ttl <= 1000, 'expiry set together with the counter');
        await a.decrement('user@example.test'); assert.equal((await b.increment('user@example.test')).totalHits, 2);
        await b.resetKey('user@example.test'); assert.equal((await a.increment('user@example.test')).totalHits, 1);
        assert.equal((await a.get('user@example.test')).totalHits, 1);
        await new Promise((resolve) => setTimeout(resolve, 1050));
        assert.equal((await b.increment('user@example.test')).totalHits, 1);
      } finally {
        const keys = await client.keys(prefix + '*'); if (keys.length) await client.del(keys);
        a.shutdown(); b.shutdown(); await client.quit();
      }
    })().then(() => process.exit(0), (error) => { console.error('Redis integration assertion failed', error); process.exit(1); });
  `);
}, 45000);

// A real outage: the container is paused (Redis stops answering), then resumed.
// The limit must keep applying during the outage (counted in memory), never let
// everything through, and Redis must take over again once it is back.
outageTest('real Redis outage: the limit still applies, then Redis takes over again', async () => {
  await run(`
    const assert = require('node:assert/strict');
    const { randomUUID } = require('node:crypto');
    const { execFileSync } = require('node:child_process');
    const { createClient } = require('redis');
    const { createRedisRateLimitStore, createRateLimit } = require('./src');
    ${waitForRedis}
    const docker = (...args) => execFileSync('docker', args, { stdio: 'ignore', timeout: 10000 });
    const hit = async (limiter, ip) => {
      const res = { statusCode: 200, headersSent: false, status(c) { this.statusCode = c; return this; }, json() { return this; }, setHeader() {} };
      let passed = false; let error;
      await limiter({ ip, headers: {} }, res, (e) => { if (e) error = e; else passed = true; });
      return { passed, status: res.statusCode, error };
    };
    (async () => {
      const client = createClient({ url: process.env.REDIS_TEST_URL });
      client.on('error', () => {}); await client.connect();
      const prefix = 'outage:' + randomUUID() + ':';
      const store = createRedisRateLimitStore({ redisUrl: process.env.REDIS_TEST_URL, prefix });
      const limiter = createRateLimit({ max: 3, windowMs: 60000, store });
      try {
        await waitForRedis(store, client, prefix, 'probe');
        assert.equal((await hit(limiter, '198.51.100.1')).passed, true);
        docker('pause', process.env.REDIS_TEST_CONTAINER);
        try {
          const during = [];
          for (let i = 0; i < 5; i++) {
            const started = Date.now();
            const r = await hit(limiter, '198.51.100.2');
            during.push(r);
            assert.ok(Date.now() - started < 8000, 'a request never hangs while Redis is down');
            assert.equal(r.error, undefined, 'no 500 while Redis is down');
          }
          assert.deepEqual(during.map((r) => r.passed), [true, true, true, false, false], 'the limit applies during the outage');
        } finally {
          docker('unpause', process.env.REDIS_TEST_CONTAINER);
        }
        const deadline = Date.now() + 10000;
        let back = false;
        while (Date.now() < deadline && !back) {
          await hit(limiter, '198.51.100.3');
          back = (await client.keys(prefix + '*')).length >= 2;
          if (!back) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(back, true, 'Redis takes over again after the outage');
      } finally {
        try { docker('unpause', process.env.REDIS_TEST_CONTAINER); } catch {}
        const keys = await client.keys(prefix + '*'); if (keys.length) await client.del(keys);
        store.shutdown(); await client.quit();
      }
    })().then(() => process.exit(0), (error) => { console.error('Redis outage assertion failed', error); process.exit(1); });
  `);
}, 60000);
