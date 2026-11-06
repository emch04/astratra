#!/usr/bin/env node
/**
 * Live run of the evaluation suite, against the real engines.
 *
 *   SERPER_API_KEY=… npm run eval:live -w @astratra/web-search
 *   node scripts/evalLive.js cases.json      # your own cases
 *
 * Engines are read from the environment exactly as by the MCP server (gateway
 * first, then direct keys). Without any key, nothing is called. Nothing is ever
 * printed about the keys: only the engine ids, the checks, the cost and the time.
 */

const fs = require('fs');
const { createWebSearch, runEvaluation, recordProviders } = require('../src');
const { providersFromEnv } = require('../src/mcpStdio');

/* Neutral, stable references: standards bodies and registries. */
const DEFAULT_CASES = [
  { id: 'http-semantics', input: { query: 'HTTP semantics RFC 9110', read: 1 }, expect: { expectedDomain: 'rfc-editor.org', within: 5 } },
  { id: 'iana-tlds', input: { query: 'IANA root zone database top-level domains' }, expect: { expectedDomain: 'iana.org', within: 3 } },
  { id: 'w3c-wcag', input: { query: 'WCAG 2.2 recommendation', sites: ['w3.org'] }, expect: { expectedDomain: 'w3.org', within: 1 } },
  { id: 'exclusion', input: { query: 'what is a domain name', excludeSites: ['wikipedia.org'] }, expect: { forbiddenDomains: ['wikipedia.org'] } },
  { id: 'recent', input: { query: 'internet standards news this week', freshness: 'week' }, expect: {} }
];

async function main() {
  const providers = await providersFromEnv(process.env);
  if (!providers.length) {
    console.log('No engine configured (SERPER_API_KEY, BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, EXA_API_KEY): nothing was called.');
    return;
  }
  const cases = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : DEFAULT_CASES;
  const recorder = recordProviders(providers);
  const reports = [];
  const ws = createWebSearch({ providers: recorder.providers, onReport: (report) => reports.push(report) });
  const evaluation = await runEvaluation({ cases, search: (input) => ws.search(input), recorder, readText: async (url) => (await ws.read(url)).text });
  for (const entry of evaluation.cases) {
    const checks = Object.entries(entry.checks).map(([name, ok]) => `${ok ? 'ok' : 'FAIL'} ${name}`).join(', ');
    console.log(`${entry.passed ? 'PASS' : 'FAIL'} ${entry.id}: ${entry.error || checks}`);
    for (const result of (entry.results || []).slice(0, 3)) console.log(`     ${result.id} ${result.domain} ${result.publishedAt ? result.publishedAt.slice(0, 10) : '-'}`);
  }
  const cost = reports.reduce((sum, report) => sum + report.costUsd, 0);
  const complete = reports.every((report) => report.costComplete);
  console.log(`\n${evaluation.summary.passed}/${evaluation.summary.cases} cases passed. Engines: ${providers.map((p) => p.id).join(', ')}.`);
  console.log(`Estimated cost: $${cost.toFixed(4)}${complete ? '' : ' (plus calls billed by the gateway)'}; time: ${reports.reduce((sum, report) => sum + report.ms, 0)} ms.`);
  for (const [name, total] of Object.entries(evaluation.summary.checks)) console.log(`  ${name}: ${total.passed}/${total.total}`);
}

main().catch((error) => {
  console.error(`eval:live: ${error.code || 'error'}: ${error.code ? error.message : 'failed'}`);
  process.exit(1);
});
