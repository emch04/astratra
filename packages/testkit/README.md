# @astratra/testkit

[English](README.md) | [Français](README.fr.md)

Security tests with no dependency, disposable MongoDB and PostgreSQL databases,
seeded country-specific fixtures, production database guards and
provider-independent agent evaluations. MIT.
Install as a development dependency. Node >= 22.22.

```sh
npm install --save-dev @astratra/testkit
```

## Security tests (`@astratra/testkit/security`)

Thirteen kinds of security tests with **no dependency** (Node only), for
`node:test` and Jest alike: each failure is an `AssertionError` that says what
to replay. The entry point loads on its own, without faker or containers.

```js
const { assertFuzz, gen, payloads, assertSafeRegex, assertConstantTime } = require('@astratra/testkit/security');
```

| Kind | Functions | What it catches |
|---|---|---|
| Fuzzing | `fuzz`, `assertFuzz`, `gen.*` | crash, slowness or broken rule over thousands of hostile inputs |
| Attack catalogue | `payloads.*`, `jwtAttacks`, `jwtClaimAttacks`, `forgeJwt` | SQL and Mongo injection, XSS, `../` paths, headers, tricky Unicode, SSRF, IPv6 in one block, "none" tokens, algorithm confusion… |
| Runaway expressions | `checkRegex`, `assertSafeRegex`, `extractRegexLiterals`, `assertLinearTime` | ReDoS, quadratic or exponential time |
| Resource bombs | `bombs.*`, `checkBounded`, `assertBounded` | exploding gzip, very deep JSON, huge text, memory or time out of bounds |
| Differential | `compareImplementations`, `assertSameBehavior` | any difference with the library being replaced |
| Standard vectors | `runVectors`, `assertVectors`, `standardVectors`, `fromWycheproof` | deviation from a standard (RFC 4226, 6238, 7515; Wycheproof files) |
| Metamorphic | `checkRelation`, `assertRelation`, `relations`, `transforms` | a broken relation (same JSON reformatted, same address upper-cased or decomposed) |
| Properties | `checkProperty`, `assertProperty` | a false rule, shrunk to its smallest example |
| Constant time | `measureTiming`, `checkConstantTime`, `assertConstantTime` | a secret comparison whose duration leaks the secret (Welch's t-test, dudect method) |
| Secrets in logs | `captureOutput`, `findSecrets`, `assertNoSecrets` | a secret written to a log, even in base64, hex or truncated |
| Authorization matrix | `checkAuthorizationMatrix`, `assertAuthorizationMatrix`, `assertNoCrossAccountAccess` | a record readable by another account (BOLA/IDOR), an open admin route |
| Races | `race`, `assertAtMost` | the last seat sold twice, a one-time code used twice |
| Injected faults | `faults.*`, `withFault`, `assertFailsClosed` | a protection that opens when Redis or the database fails |
| Mutations | `runMutations`, `assertMutationsKilled` | code the tests do not protect |
| Supply chain | `checkLockfile`, `assertLockfile`, `checkDependencyAllowlist`, `assertDependencyAllowlist` | a package from outside the registry, without a sha512 hash, running an install script; an undecided dependency |

Everything random starts from a seed (`seed`, 1 by default). A failure prints
it: `SECURITY_TEST_SEED=<seed>` replays exactly the same inputs.

```js
await assertFuzz(parseToken, { generator: gen.oneOf(gen.hostileString(), gen.mutated([validToken])), runs: 2000 });
for (const { name, token } of jwtAttacks(validToken, { publicKey })) assert.equal(verify(token), null, name);
assertConstantTime((candidate) => compare(candidate, secret), { classes: [() => wrongAtStart, () => wrongAtEnd] });
await assertAtMost(() => book(lastSeat), { max: 1, concurrency: 50 });
await assertFailsClosed(redisClient, 'eval', faults.rejecting(), () => callRoute());
```

Limits: constant time is statistical evidence, not proof (buffers are copied
before each measurement, and a leak must show at every attempt). Fuzzing is
random, without coverage instrumentation. `checkRegex` tries attacks guessed
from the expression, each in a worker stopped after the time limit; passing
does not prove safety for every input. `fromWycheproof` reads files from the
Wycheproof project (C2SP, Apache-2.0), downloaded from its repository; they are
not copied here.

## Agent evaluation

`evaluateAgent({ scenarios, run, signal? })` evaluates an injected runner and
returns `{ results, score, passed, total }`. No model provider is imposed.

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAgent } = require('@astratra/testkit');

test('uses a lookup result', async () => {
  const report = await evaluateAgent({
    scenarios: [{
      id: 'lookup', question: 'Find the value.',
      tools: [{ name: 'lookup', run: async () => ({ data: '42' }) }],
      expect: { tools: ['lookup'], content: ['42'] }
    }],
    run: async ({ question, tools, signal }) => {
      const value = await tools[0].run({});
      return { text: value.data };
    }
  });
  assert.equal(report.passed, report.total);
});
```

Each scenario has `id`, `question`, optional simulated `tools`, `expect` and
`score`. The runner receives `{ question, tools, signal }` and returns text or
an object with `text`. Tools retain their other fields, allowing native tool
fixtures to be passed to a task runner. Recorded calls include names and args.
Expected tool names must have been called; content expectations accept strings
or regular expressions. The default score is the fraction of satisfied checks,
or one when no checks are defined. `score({ text, calls, output, checks })` can
return an asynchronous number between zero and one. Scenario failures produce
a zero score and an error; cancellation propagates. Overall score is the mean
of scenario scores (zero for an empty report). A scenario passes only when all
checks pass and its score is one. The report is data, suitable for `node --test`
assertions or application reporting. It does not judge tool ordering or absence
unless a custom scoring function does so.

## Disposable databases

Install `@testcontainers/mongodb` or `@testcontainers/postgresql` for the engine
used. Docker is required for real containers.

```js
const { startPostgres, startMongo, isDockerAvailable } = require('@astratra/testkit');
if (isDockerAvailable()) {
  const db = await startPostgres({ database: 'app_test' });
  // Connect the application's driver to db.uri.
  await db.stop();
}
```

MongoDB uses `mongo:8` with a replica set; PostgreSQL uses `postgres:17-alpine`.
Both expose `{ uri, stop }`, use a random port and validate the generated URI.
Without Docker, skip container integration tests explicitly.

## Seeded fixtures

```js
const { createFakeData, supportedCountries } = require('@astratra/testkit');
const data = createFakeData({ country: 'FR', seed: 42 });
data.person();
data.people(3, { minAge: 6, maxAge: 18 });
data.organization();
data.phone();
```

Twenty countries are supported; `supportedCountries()` lists them. The faker
instance is available as `data.faker`. Ages use a fixed reference date so a seed
stays reproducible. Emails use the reserved `example.test` domain. Geographic
fields are independent fixtures and do not form an address directory.

## Database guard

`assertSafeTestDatabaseUri(uri, { allowRemoteHosts? })` throws
`UnsafeTestDatabaseError` with `reason` on refusal; `isSafeTestDatabaseUri`
returns a boolean. Production environment, managed hosts, `mongodb+srv`,
production-looking host/database names, unapproved remote hosts and unmarked
production environment URIs are refused. Even explicitly allowed remote hosts
must use a test-marked database. Call the guard before destructive test setup.

## Jest compatibility

Faker 10 is ESM. Node loads it directly; Jest CommonJS needs the provided
preset to transform faker through Babel. Since 2.0.0 the Babel plugin is an
optional peer dependency, installed only by projects that use the preset:

```sh
npm install --save-dev @babel/plugin-transform-modules-commonjs
```

```json
{ "jest": { "preset": "@astratra/testkit" } }
```

Existing transform settings can copy `jest-preset.js`. The only runtime
dependency is faker 10 (MIT); the security entry point has none. The
evaluation harness also works directly with `node --test`.
