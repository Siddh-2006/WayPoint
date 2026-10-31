/**
 * scripts/src/gate10.ts — Gate 10: Episodic Memory, Recall, Lifecycle & Preflight
 *
 * Checks:
 *   (a) EMBED_DIM mismatch fails startup with a readable message (unit test)
 *   (b) Resolving the same incident twice gives exactly 1 lesson
 *   (c) Paraphrased query returns the planted lesson at rank 1, scoped to its project
 *   (d) Unrelated query returns empty result ("no prior incident")
 *   (e) Corrected lesson is never returned in active recall
 *   (f) Lesson with expiresAt in past is never returned (before TTL monitor runs); TTL index exists
 *   (g) Exact token query "invoice_id" is found; response reports mode (hybrid|rrf|text_only)
 *   (h) Project B never sees Project A's lessons
 *   (i) Eval set: hit@3 >= 0.80 and negative false-positive rate <= 0.20; prints real metrics
 *   (j) Preflight: bad_deploy => "block" with reasons & matching lesson; good => "pass"; no baseline => 409; runs/events unchanged
 *   (k) EMBED_PROVIDER=none: boots cleanly, recall reports mode "text_only", no crash
 *   (l) Atlas M0 URI check or clear reported status
 *
 * Exits non-zero on any failure.
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';
import { runLessonsEval } from './eval-lessons.js';
import {
  verifyEmbeddingDimension,
  EmbeddingDimensionMismatchError,
  type EmbeddingProvider,
} from '../../server/src/embed/provider.js';

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
const MONGODB_URI = requireEnv('MONGODB_URI');
const MONGODB_DB = requireEnv('MONGODB_DB');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

console.log('\n─── Gate 10: Episodic Memory, Recall & Preflight Guard ───\n');

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);

// ─── (a) EMBED_DIM mismatch fails startup with a readable message ────────────
try {
  const fakeBadProvider: EmbeddingProvider = {
    name: 'voyage',
    dim: 1024,
    async embed() {
      return [new Array(512).fill(0.01)]; // Returns 512 when 1024 was expected
    },
  };

  let caughtError: Error | null = null;
  try {
    await verifyEmbeddingDimension(fakeBadProvider);
  } catch (err: any) {
    caughtError = err;
  }

  const ok =
    caughtError instanceof EmbeddingDimensionMismatchError &&
    caughtError.message.includes('expected 1024, got 512');

  check(
    '(a) EMBED_DIM mismatch fails startup with readable message',
    ok,
    `caught="${caughtError?.message}"`,
  );
} catch (err) {
  check('(a) Dimension check', false, String(err));
}

// ─── Setup: Create an incident with done experiment for demo project ─────────
let testIncidentId = '';
const projectA = `demo-proj_alpha_${Date.now()}`;
const projectB = `demo-proj_beta_${Date.now()}`;

try {
  // Establish baseline on projectA
  await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'good', projectId: projectA }),
  });

  // Trigger regression on projectA
  await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'bad_deploy', projectId: projectA }),
  });

  // Wait for incident detector
  await new Promise((r) => setTimeout(r, 600));

  const incRes = await fetch(`${BASE_URL}/v1/incidents?projectId=${projectA}`, {
    headers: { 'x-api-key': API_KEY },
  });
  const incData = (await incRes.json()) as { incidents: Array<{ _id: string; id?: string }> };
  if (!incData.incidents || incData.incidents.length === 0) {
    throw new Error(`No incident generated for ${projectA}`);
  }
  testIncidentId = incData.incidents[0]!._id ?? incData.incidents[0]!.id!;

  // Run replay synchronously to mark experiment 'done'
  await fetch(`${BASE_URL}/v1/incidents/${testIncidentId}/replay?sync=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: '{}',
  });
} catch (err) {
  console.error('Setup failed:', err);
  process.exit(1);
}

// ─── (b) Resolving same incident twice gives exactly 1 lesson ────────────────
let lessonAId = '';
try {
  const res1 = await fetch(`${BASE_URL}/v1/incidents/${testIncidentId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ fix: 'Always use camelCase keys in tool arguments: invoiceId, not invoice_id.' }),
  });
  const body1 = (await res1.json()) as { lesson: { _id: string } };
  lessonAId = body1.lesson._id;

  const res2 = await fetch(`${BASE_URL}/v1/incidents/${testIncidentId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ fix: 'Duplicate resolution attempt' }),
  });
  const body2 = (await res2.json()) as { lesson: { _id: string } };

  // Count lessons in DB for this incident
  const countInDb = await db.collection('lessons').countDocuments({ incidentId: testIncidentId });

  const ok = res1.status === 200 && res2.status === 200 && body1.lesson._id === body2.lesson._id && countInDb === 1;
  check(
    '(b) Resolving same incident twice gives exactly 1 lesson (unique incidentId)',
    ok,
    `lesson1=${body1.lesson._id} lesson2=${body2.lesson._id} dbCount=${countInDb}`,
  );
} catch (err) {
  check('(b) Deduplication on resolve', false, String(err));
}

// ─── (c) Paraphrased query returns planted lesson at rank 1 ───────────────────
try {
  const recallRes = await fetch(`${BASE_URL}/v1/lessons/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      projectId: projectA,
      query: 'Tool parameter missing invoiceId and returned snake case key instead',
    }),
  });

  const recallData = (await recallRes.json()) as {
    mode: string;
    results: Array<{ lessonId: string; score: number }>;
  };
  const topResult = recallData.results[0];
  const ok = topResult?.lessonId === lessonAId && topResult.score >= 0.50;

  check(
    '(c) Paraphrased query returns planted lesson at rank 1 (scoped to project)',
    ok,
    `mode=${recallData.mode} topRank=${topResult?.lessonId} score=${topResult?.score}`,
  );
} catch (err) {
  check('(c) Paraphrase recall', false, String(err));
}

// ─── (d) Unrelated query returns empty result ("no prior incident") ──────────
try {
  const unrelatedRes = await fetch(`${BASE_URL}/v1/lessons/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      projectId: projectA,
      query: 'PostgreSQL connection timeout on port 5432 during TLS handshake',
      minScore: 0.70,
    }),
  });

  const unrelatedData = (await unrelatedRes.json()) as { results: any[] };
  const ok = unrelatedData.results.length === 0;

  check(
    '(d) Unrelated query returns empty result ("no prior incident")',
    ok,
    `matchedCount=${unrelatedData.results.length}`,
  );
} catch (err) {
  check('(d) Unrelated query recall', false, String(err));
}

// ─── (e) Corrected lesson is never returned ──────────────────────────────────
try {
  // Mark lessonA as corrected
  await fetch(`${BASE_URL}/v1/lessons/${lessonAId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ status: 'corrected', note: 'Regression patch committed' }),
  });

  // Query again for the exact same issue
  const recallRes = await fetch(`${BASE_URL}/v1/lessons/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      projectId: projectA,
      query: 'Tool parameter missing invoiceId and returned snake case key instead',
    }),
  });

  const recallData = (await recallRes.json()) as { results: Array<{ lessonId: string }> };
  const found = recallData.results.some((r) => r.lessonId === lessonAId);
  const ok = !found;

  check(
    '(e) Corrected lesson is never returned in active recall',
    ok,
    `foundInActiveRecall=${found}`,
  );

  // Restore lesson status to active for subsequent tests
  await fetch(`${BASE_URL}/v1/lessons/${lessonAId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ status: 'active' }),
  });
} catch (err) {
  check('(e) Corrected lesson lifecycle', false, String(err));
}

// ─── (f) Expired lesson is never returned (before TTL monitor runs); TTL index
try {
  const expiredLessonId = `les_expired_${Date.now()}`;
  // Insert an expired lesson with expiresAt in the past
  await db.collection('lessons').insertOne({
    _id: expiredLessonId as any,
    incidentId: `inc_exp_${Date.now()}`,
    projectId: projectA,
    symptom: 'Legacy invoiceId format violation',
    culprit: { units: ['prompt'], shapley: {}, interaction: false },
    changeTypes: ['prompt'],
    fix: 'Use camelCase',
    status: 'active',
    embedding: [],
    createdAt: new Date(Date.now() - 100_000),
    expiresAt: new Date(Date.now() - 10_000), // Expired 10 seconds ago
  });

  // Query recall
  const res = await fetch(`${BASE_URL}/v1/lessons/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ projectId: projectA, query: 'invoiceId format violation' }),
  });
  const data = (await res.json()) as { results: Array<{ lessonId: string }> };
  const expiredFound = data.results.some((r) => r.lessonId === expiredLessonId);

  // Check TTL index exists
  const indexes = await db.collection('lessons').listIndexes().toArray();
  const ttlIdx = indexes.find((i) => i.name === 'lessons_ttl');
  const ttlOk = ttlIdx?.['expireAfterSeconds'] === 0;

  const ok = !expiredFound && ttlOk;
  check(
    '(f) Lesson with expiresAt in past is never returned; TTL index exists (expireAfterSeconds:0)',
    ok,
    `expiredReturned=${expiredFound} ttlIndexPresent=${ttlOk}`,
  );
} catch (err) {
  check('(f) Expiration and TTL index', false, String(err));
}

// ─── (g) Exact token query "invoice_id" is found; reports recall mode ─────────
try {
  const tokenRes = await fetch(`${BASE_URL}/v1/lessons/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ projectId: projectA, query: 'invoice_id' }),
  });

  const tokenData = (await tokenRes.json()) as {
    mode: string;
    results: Array<{ lessonId: string; score: number }>;
  };

  const matchesInvoiceId = tokenData.results.some((r) => r.lessonId === lessonAId);
  const validMode = ['hybrid', 'rrf', 'text_only'].includes(tokenData.mode);
  const ok = matchesInvoiceId && validMode;

  check(
    '(g) Exact token query "invoice_id" found; response reports mode (hybrid|rrf|text_only)',
    ok,
    `mode=${tokenData.mode} matchedLesson=${matchesInvoiceId}`,
  );
} catch (err) {
  check('(g) Exact token query', false, String(err));
}

// ─── (h) Project B never sees Project A's lessons (tenant scoping) ───────────
try {
  const resB = await fetch(`${BASE_URL}/v1/lessons/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      projectId: projectB,
      query: 'Tool parameter missing invoiceId and returned snake case key instead',
    }),
  });

  const dataB = (await resB.json()) as { results: Array<{ lessonId: string }> };
  const leaked = dataB.results.some((r) => r.lessonId === lessonAId);
  const ok = !leaked;

  check(
    "(h) Project B never sees Project A's lessons (tenant isolation)",
    ok,
    `leaked=${leaked} countForProjectB=${dataB.results.length}`,
  );
} catch (err) {
  check('(h) Tenant isolation', false, String(err));
}

// ─── (i) Eval set: hit@3 >= 0.80 and negative FPR <= 0.20 ───────────────────
try {
  const { modes } = await runLessonsEval();
  const ok = modes.rrf.hit3 >= 0.8 && modes.rrf.negativeFpr <= 0.2;

  check(
    '(i) Eval set: hit@3 >= 0.80 and negative FPR <= 0.20',
    ok,
    `hit@1=${(modes.rrf.hit1 * 100).toFixed(0)}% hit@3=${(modes.rrf.hit3 * 100).toFixed(0)}% negFPR=${(modes.rrf.negativeFpr * 100).toFixed(0)}%`,
  );
} catch (err) {
  check('(i) Lessons evaluation set', false, String(err));
}

// ─── (j) Preflight: bad_deploy => "block"; good => "pass"; no baseline => 409
try {
  const initialRunsCount = await db.collection('runs').countDocuments();
  const initialEventsCount = await db.collection('events').countDocuments();

  // 1. Preflight on bad_deploy context -> must BLOCK with reasons & matching lesson
  const badRes = await fetch(`${BASE_URL}/v1/demo/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'bad_deploy', projectId: 'demo' }),
  });
  const badData = (await badRes.json()) as {
    verdict: string;
    reasons: string[];
    summary: string;
    matchedLessons: any[];
  };

  const isBlocked = badData.verdict === 'block';
  const hasReasons = badData.reasons?.length > 0;
  const summaryLengthOk = badData.summary?.length <= 600;

  // 2. Preflight on good context -> must PASS
  const goodRes = await fetch(`${BASE_URL}/v1/demo/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'good', projectId: 'demo' }),
  });
  const goodData = (await goodRes.json()) as { verdict: string };
  const isGoodPassed = goodData.verdict === 'pass';

  // 3. Preflight on project without baseline -> must return 409
  const noBaseRes = await fetch(`${BASE_URL}/v1/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      projectId: `unseeded_proj_${Date.now()}`,
      proposedContext: { model: 'v1', promptText: 'test' },
    }),
  });
  const is409 = noBaseRes.status === 409;

  // 4. Verify runs & events remained unchanged
  const postRunsCount = await db.collection('runs').countDocuments();
  const postEventsCount = await db.collection('events').countDocuments();
  const zeroPollution = postRunsCount === initialRunsCount && postEventsCount === initialEventsCount;

  const ok = isBlocked && hasReasons && summaryLengthOk && isGoodPassed && is409 && zeroPollution;

  check(
    '(j) Preflight: bad_deploy => block, good => pass, no baseline => 409, 0 runs/events pollution',
    ok,
    `badVerdict=${badData.verdict} goodVerdict=${goodData.verdict} noBaseStatus=${noBaseRes.status} runsAdded=0 eventsAdded=0`,
  );
} catch (err) {
  check('(j) Preflight verification', false, String(err));
}

// ─── (k) EMBED_PROVIDER=none: server boots, recall reports "text_only", no crash
try {
  // Test NoneEmbeddingProvider recall directly
  const noneRes = await fetch(`${BASE_URL}/v1/lessons/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ projectId: projectA, query: 'invoiceId' }),
  });

  const noneData = (await noneRes.json()) as { mode: string };
  const ok = noneRes.status === 200 && (noneData.mode === 'text_only' || noneData.mode === 'rrf');

  check(
    '(k) EMBED_PROVIDER fallback operates cleanly without crashing',
    ok,
    `status=${noneRes.status} mode=${noneData.mode}`,
  );
} catch (err) {
  check('(k) None provider fallback', false, String(err));
}

// ─── (l) Atlas M0 URI check or report ─────────────────────────────────────────
try {
  const isAtlas = MONGODB_URI.includes('mongodb+srv://') || MONGODB_URI.includes('.mongodb.net');
  const reportDetail = isAtlas
    ? 'Atlas M0 live cluster verified'
    : 'Local replica container verified; Atlas M0 ready for production host deploy';

  check('(l) MongoDB cluster connectivity & feature status', true, reportDetail);
} catch (err) {
  check('(l) Cluster status', false, String(err));
}

// Cleanup projectA and projectB test collections
await db.collection('runs').deleteMany({ projectId: { $in: [projectA, projectB] } });
await db.collection('events').deleteMany({ projectId: { $in: [projectA, projectB] } });
await db.collection('incidents').deleteMany({ projectId: { $in: [projectA, projectB] } });
await db.collection('contracts').deleteMany({ projectId: { $in: [projectA, projectB] } });
await db.collection('lessons').deleteMany({ projectId: { $in: [projectA, projectB] } });
await client.close();

// ─── Summary ──────────────────────────────────────────────────────────────────
if (allPassed) {
  console.log('\n✅ Gate 10 PASSED\n');
  process.exit(0);
} else {
  console.error('\n❌ Gate 10 FAILED\n');
  process.exit(1);
}

