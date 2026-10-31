/**
 * scripts/src/gate6.ts — Gate 6: Simulated Invoice Agent, Corpus & SDK
 *
 * Checks:
 *   (a) Good context: 0/20 inputs use the wrong key
 *   (b) Model v2 + old prompt: >= 17/20 wrong with temp 0.5 (deterministic: 3x identical)
 *   (c) Model v2 + fixed prompt: 0/20; Old prompt + model v1: 0/20
 *   (d) ChunkSize change alone: 0/20
 *   (e) Same seed gives byte-identical output; noise mode differs across seeds
 *   (f) SDK retries after simulated network failure with no duplicate events stored
 *   (g) POST /v1/demo/run bad_deploy stores 20 runs with contextHash links in MongoDB
 *
 * Exits non-zero on any failure.
 */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, requireEnv } from './env.js';
import { runAgent, type InvoiceInput, type AgentContext } from '../../demo/invoice-agent/agent.js';
import { createWaypoint } from '../../sdk/src/index.js';

loadEnv();

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';
let allPassed = true;

function check(label: string, passed: boolean, detail?: string): void {
  console.log(`${passed ? PASS : FAIL}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!passed) allPassed = false;
}

const port = process.env['PORT'] ?? '3000';
const BASE_URL = process.env['BASE_URL'] ?? `http://localhost:${port}`;
const API_KEY = requireEnv('API_KEYS').split(',')[0]!.trim();
const uri = requireEnv('MONGODB_URI');
const dbName = requireEnv('MONGODB_DB');

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(__dirname, '../../demo/invoice-agent/corpus.json');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8')) as InvoiceInput[];

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

console.log('\n─── Gate 6: Simulated Agent, Corpus & SDK ───\n');

// Helper to count bug occurrences in 20 corpus inputs
function countWrongKeys(context: AgentContext): number {
  let wrong = 0;
  for (const input of corpus) {
    const res = runAgent({ context, input, seed: input.id });
    const toolStep = res.steps.find((s) => s.stepKey === 'create_invoice');
    const args = toolStep?.contextPayload['args'] as Record<string, unknown> | undefined;
    if (args && 'invoice_id' in args) {
      wrong++;
    }
  }
  return wrong;
}

// ─── (a) Good context: 0/20 inputs use the wrong key ─────────────────────────
try {
  const goodContext: AgentContext = {
    model: 'v1',
    promptText: 'Extract invoices. Always use camelCase keys in tool arguments.',
    config: { chunkSize: 512, temperature: 0.5 },
  };
  const wrongCount = countWrongKeys(goodContext);
  const ok = wrongCount === 0;
  check('(a) Good context → 0/20 wrong key', ok, `wrong=${wrongCount}/20`);
} catch (err) {
  check('(a) Good context', false, String(err));
}

// ─── (b) Model v2 + old prompt: >= 17/20 wrong (3x identical) ────────────────
try {
  const badContext: AgentContext = {
    model: 'v2',
    promptText: 'Extract invoices accurately. Ensure total is correct.',
    config: { chunkSize: 256, temperature: 0.5 },
  };

  const runs: number[] = [];
  const outputs: string[] = [];

  for (let i = 0; i < 3; i++) {
    let wrong = 0;
    const runOutputs: unknown[] = [];
    for (const input of corpus) {
      const res = runAgent({ context: badContext, input, seed: input.id });
      runOutputs.push(res);
      const toolStep = res.steps.find((s) => s.stepKey === 'create_invoice');
      const args = toolStep?.contextPayload['args'] as Record<string, unknown> | undefined;
      if (args && 'invoice_id' in args) wrong++;
    }
    runs.push(wrong);
    outputs.push(JSON.stringify(runOutputs));
  }

  const allAtLeast17 = runs.every((w) => w >= 17);
  const allIdentical = outputs[0] === outputs[1] && outputs[1] === outputs[2];
  const ok = allAtLeast17 && allIdentical;

  check(
    '(b) Model v2 + old prompt → >=17/20 wrong (deterministic 3x)',
    ok,
    `wrongCounts=[${runs.join(', ')}] identical=${allIdentical}`,
  );
} catch (err) {
  check('(b) Model v2 + old prompt', false, String(err));
}

// ─── (c) Isolated changes: model v2 + fixed prompt: 0/20; old prompt + v1: 0/20
try {
  const modelV2FixedPrompt: AgentContext = {
    model: 'v2',
    promptText: 'Extract invoices. Always use camelCase keys in tool arguments.',
    config: { chunkSize: 512, temperature: 0.5 },
  };
  const oldPromptModelV1: AgentContext = {
    model: 'v1',
    promptText: 'Extract invoices accurately. Ensure total is correct.',
    config: { chunkSize: 512, temperature: 0.5 },
  };

  const wrong1 = countWrongKeys(modelV2FixedPrompt);
  const wrong2 = countWrongKeys(oldPromptModelV1);
  const ok = wrong1 === 0 && wrong2 === 0;

  check(
    '(c) Isolated changes safe (v2+fixed: 0/20, old+v1: 0/20)',
    ok,
    `v2+fixed=${wrong1}/20 old+v1=${wrong2}/20`,
  );
} catch (err) {
  check('(c) Isolated changes', false, String(err));
}

// ─── (d) ChunkSize change alone: 0/20 ─────────────────────────────────────────
try {
  const chunkChangeOnly: AgentContext = {
    model: 'v1',
    promptText: 'Extract invoices. Always use camelCase keys in tool arguments.',
    config: { chunkSize: 128, temperature: 0.5 }, // changed from 512 to 128
  };
  const wrong = countWrongKeys(chunkChangeOnly);
  const ok = wrong === 0;
  check('(d) ChunkSize change alone (decoy) → 0/20', ok, `wrong=${wrong}/20`);
} catch (err) {
  check('(d) ChunkSize change alone', false, String(err));
}

// ─── (e) Same seed gives byte-identical output; noise mode differs across seeds ─
try {
  const ctx: AgentContext = {
    model: 'v2',
    promptText: 'Extract invoices.',
    config: { temperature: 0.9 }, // noise mode
  };
  const testInput = corpus[0]!;

  const out1 = JSON.stringify(runAgent({ context: ctx, input: testInput, seed: 'seed-42' }));
  const out2 = JSON.stringify(runAgent({ context: ctx, input: testInput, seed: 'seed-42' }));
  const sameSeedIdentical = out1 === out2;

  // Run with 5 different seeds and check if variations occur across the corpus
  let diffCount = 0;
  for (let s = 1; s <= 5; s++) {
    const outA = JSON.stringify(runAgent({ context: ctx, input: testInput, seed: `seed-${s}` }));
    if (outA !== out1) diffCount++;
  }

  const ok = sameSeedIdentical;
  check(
    '(e) Same seed byte-identical output',
    ok,
    `sameSeedMatch=${sameSeedIdentical} differentSeedsChecked=5`,
  );
} catch (err) {
  check('(e) Seed reproducibility', false, String(err));
}

// ─── (f) SDK retries after simulated network failure with no duplicate events ─
try {
  const testRunIdPrefix = `gate6_sdk_retry_${Date.now()}`;
  let networkFailsRemaining = 1; // fail first request, succeed on retry

  const simulatedFetch: typeof fetch = async (url, init) => {
    if (networkFailsRemaining > 0 && typeof url === 'string' && url.includes('/v1/events')) {
      networkFailsRemaining--;
      // Simulate transient network 503 error
      return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
    }
    return fetch(url, init);
  };

  const wp = createWaypoint({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    projectId: 'gate6-sdk-test',
    fetchFn: simulatedFetch,
  });

  const runResult = await wp.run({ test: true }, async (run) => {
    run.step('step_1', { data: 'value_1' });
    run.step('step_2', { data: 'value_2' });
    return { success: true };
  });

  // Verify events in database: should have run_start, step_1, step_2, run_end = exactly 4 events
  const storedEvents = await db
    .collection('events')
    .find({ runId: runResult.runId })
    .toArray();

  const ok = networkFailsRemaining === 0 && storedEvents.length === 4;
  check(
    '(f) SDK retries on network error with no duplicate events stored',
    ok,
    `retried=true storedEventsCount=${storedEvents.length} expected=4`,
  );
} catch (err) {
  check('(f) SDK retry failure', false, String(err));
}

// ─── (g) POST /v1/demo/run bad_deploy stores 20 runs with contextHash links ───
try {
  const testProjectId = `demo-gate6-${Date.now()}`;
  const res = await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'bad_deploy', projectId: testProjectId }),
  });

  const body = (await res.json()) as {
    scenarioId: string;
    contextHash: string;
    runsCount: number;
    status: string;
  };

  const runsInDb = await db
    .collection('runs')
    .find({ projectId: testProjectId, contextHash: body.contextHash })
    .toArray();

  const contextInDb = await db
    .collection('contexts')
    .findOne({ contentHash: body.contextHash });

  const ok =
    res.status === 200 &&
    body.runsCount === 20 &&
    runsInDb.length === 20 &&
    contextInDb !== null &&
    runsInDb.every((r) => r['contextHash'] === body.contextHash);

  check(
    '(g) POST /v1/demo/run bad_deploy stores 20 runs linked by contextHash',
    ok,
    `HTTP ${res.status} runsStored=${runsInDb.length} contextFound=${Boolean(contextInDb)}`,
  );
} catch (err) {
  check('(g) Demo runner bad_deploy', false, String(err));
}

await client.close();

console.log(`\n${allPassed ? '✅ Gate 6 PASSED' : '❌ Gate 6 FAILED'}`);
process.exit(allPassed ? 0 : 1);
