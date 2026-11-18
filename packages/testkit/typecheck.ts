import { assertSafeTestDatabaseUri, createFakeData, isDockerAvailable, isSafeTestDatabaseUri, startMongo, startPostgres, supportedCountries, UnsafeTestDatabaseError } from './src';
import type { FakeData, FakePerson, TestDatabase } from './src';

const data: FakeData = createFakeData({ country: 'CD', seed: 42 });
const people: FakePerson[] = data.people(3, { minAge: 6, maxAge: 18 });
const phone: string = data.phone();
const countries: string[] = supportedCountries();

async function exercise(): Promise<void> {
  assertSafeTestDatabaseUri('mongodb://localhost:27017/app_test', { allowRemoteHosts: ['ci-db.internal.example'] });
  const safe: boolean = isSafeTestDatabaseUri('mongodb+srv://x.mongodb.net/app');
  if (isDockerAvailable()) {
    const mongo: TestDatabase = await startMongo({ database: 'app_test' });
    const pg: TestDatabase = await startPostgres();
    await mongo.stop();
    await pg.stop();
  }
  try {
    assertSafeTestDatabaseUri('x');
  } catch (error) {
    if (error instanceof UnsafeTestDatabaseError) void error.reason;
  }
  void [people, phone, countries, safe];
}
void exercise;

import { evaluateAgent } from './src';
void evaluateAgent({ scenarios: [{ id: 'lookup', question: 'Find', expect: { content: [/found/] }, score: ({ text }) => text ? 1 : 0 }], run: async () => ({ text: 'found' }) });

// L'entrée sécurité : chaque famille d'essais garde ses types.
import { assertFuzz, gen, payloads, assertSafeRegex, assertConstantTime, assertAuthorizationMatrix, assertAtMost, faults, assertFailsClosed, assertNoSecrets, captureOutput, jwtAttacks, forgeJwt, assertVectors, standardVectors, assertRelation, relations, transforms, bombs, assertBounded, assertLockfile } from './security';
import type { FuzzReport, MatrixReport } from './security';

async function exerciseSecurity(): Promise<void> {
  const fuzzed: FuzzReport<string> = await assertFuzz((input: string) => input.trim(), { generator: gen.hostileString(), runs: 10 });
  const sql: string[] = payloads.sqlInjection;
  await assertSafeRegex(/^[a-z]+$/);
  assertConstantTime((b: Buffer) => b.length, { classes: [() => Buffer.alloc(8), () => Buffer.alloc(8, 1)] });
  const matrix: MatrixReport = await assertAuthorizationMatrix({ actors: { anonymous: null }, actions: ['read'], resources: { note: { owner: 'a' } }, expected: () => 'deny', attempt: () => 401 });
  await assertAtMost(async () => ({ status: 201 }), { max: 1 });
  const store = { increment: async () => 1 };
  await assertFailsClosed(store, 'increment', faults.rejecting(), async () => ({ status: 503 }));
  const { output } = await captureOutput(() => 1);
  assertNoSecrets(output, { secrets: ['secret-value'] });
  const forged: { name: string; token: string }[] = jwtAttacks(forgeJwt({ payload: { sub: 'u' }, secret: 's' }));
  await assertVectors(standardVectors.hotpRfc4226, ({ counter }) => String(counter));
  await assertRelation({ inputs: ['a'], transform: transforms.nfd, run: (s: string) => s, relation: relations.same });
  await assertBounded(() => bombs.gzip(1024));
  assertLockfile({ packages: {} });
  void fuzzed;
  void sql;
  void matrix;
  void forged;
}
void exerciseSecurity;
