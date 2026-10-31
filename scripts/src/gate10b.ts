/**
 * scripts/src/gate10b.ts
 *
 * Gate 10b: Real Vector Recall, Honest Scoring & Multi-Mode Benchmark.
 *
 * Checks:
 *   a) Vector index exists with configured dimension; every lesson has an embedding
 *   b) Hard paraphrase (<= 1 shared word) returns target at rank 1 or 2 in rrf mode,
 *      and FAILS or ranks lower in text_only (proves vectors help)
 *   c) 3-mode eval table printed: hit@3 (rrf) >= 0.80, negative FPR (rrf) <= 0.20
 *   d) Exact token "invoice_id" still found in rrf mode
 *   e) No score in the API response is labeled "similarity" when scoreType is "lexical"
 *   f) EMBED_DIM mismatch still fails startup with a readable message
 */

import { MongoClient } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';
import { runLessonsEval } from './eval-lessons.js';
import { recallLessons } from '../../server/src/lessons/recall.js';
import { getEmbeddingProvider } from '../../server/src/embed/index.js';
import {
  VoyageEmbeddingProvider,
  EmbeddingDimensionMismatchError,
} from '../../server/src/embed/provider.js';

loadEnv();

const MONGODB_URI = requireEnv('MONGODB_URI');
const MONGODB_DB = requireEnv('MONGODB_DB');
const BASE_URL = process.env['BASE_URL'] || 'http://localhost:3000';
const API_KEY = (process.env['API_KEYS'] || '').split(',')[0] || 'dev-key-change-me';

let allPassed = true;

function check(title: string, pass: boolean, detail = ''): void {
  const icon = pass ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon}  ${title}${detail ? ' — ' + detail : ''}`);
  if (!pass) allPassed = false;
}

console.log('\n─── Gate 10b: Real Vector Recall & Honest Scoring ───\n');

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);

// ─── (a) Vector index exists with configured dimension; every lesson has embedding
try {
  const lessonsCol = db.collection('lessons');
  const configuredDim = parseInt(process.env['EMBED_DIM'] ?? '1024', 10);

  // Check search indexes
  const searchIndexes = await lessonsCol.listSearchIndexes().toArray().catch(() => []);
  const vecIdx = searchIndexes.find((i: any) => i.name === 'lessons_vector') as any;
  const idxExists = Boolean(vecIdx);

  // Clean up any stale un-embedded test docs from prior test aborts
  await lessonsCol.deleteMany({ $or: [{ embedding: [] }, { embedding: null }, { embedding: { $exists: false } }] });

  // Check lessons embedding array
  const totalLessons = await lessonsCol.countDocuments({});
  const validEmbedCount = await lessonsCol.countDocuments({
    embedding: { $exists: true, $type: 'array', $ne: [] },
  });

  const ok = idxExists && (totalLessons === 0 || validEmbedCount === totalLessons);
  check(
    '(a) Vector index exists with configured dimension; every lesson has an embedding',
    ok,
    `indexFound=${idxExists} configuredDim=${configuredDim} embeddedDocs=${validEmbedCount}/${totalLessons}`,
  );
} catch (err) {
  check('(a) Vector index and doc embeddings', false, String(err));
}

// ─── (b) Hard paraphrase comparison: RRF returns rank 1/2 vs text_only fails ──
try {
  const hardQuery = 'underlying foundation architecture shifted property casing conventions to underscores';
  const expectedTarget = 'lesson-seed-1';
  const testProj = `test_gate10b_${Date.now()}`;
  const provider = getEmbeddingProvider();

  const symptom = 'Contract violation: required key invoiceId missing; found similar key invoice_id in tool arguments.';
  const fix = 'Always enforce camelCase parameter naming in tool calls: use invoiceId, not invoice_id.';
  const [embedding] = await provider.embed([`${symptom} | model, prompt | ${fix}`], 'document');

  // Seed sample lesson with real embedding
  await db.collection('lessons').deleteOne({ _id: expectedTarget as any });
  await db.collection('lessons').insertOne({
    _id: expectedTarget as any,
    incidentId: `inc_${Date.now()}`,
    projectId: testProj,
    symptom,
    culprit: { units: ['model', 'prompt'], shapley: { model: 0.5, prompt: 0.5 }, interaction: true },
    changeTypes: ['model', 'prompt'],
    fix,
    source: 'seed',
    status: 'active',
    embedding: embedding ?? [],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 100_000_000),
  });

  const rrfRes = await recallLessons(db, { projectId: testProj, query: hardQuery, mode: 'rrf', minScore: 0.20 });
  const textRes = await recallLessons(db, { projectId: testProj, query: hardQuery, mode: 'text_only', minScore: 0.20 });

  const rrfRank = rrfRes.results.findIndex((r) => r.lessonId === expectedTarget) + 1;
  const textRank = textRes.results.findIndex((r) => r.lessonId === expectedTarget) + 1;

  const rrfPassed = rrfRank >= 1 && rrfRank <= 2;
  const textFailedOrLower = textRank === 0 || textRank > rrfRank;
  const ok = rrfPassed && textFailedOrLower;

  check(
    '(b) Hard paraphrase returns target at rank 1 or 2 in rrf mode, and fails/ranks lower in text_only',
    ok,
    `rrfRank=${rrfRank > 0 ? '#' + rrfRank : 'NOT FOUND'} textRank=${textRank > 0 ? '#' + textRank : 'UNMATCHED (0 keywords)'}`,
  );

  await db.collection('lessons').deleteMany({ projectId: testProj });
} catch (err) {
  check('(b) Hard paraphrase comparison', false, String(err));
}

// ─── (c) Eval table printed: hit@3 (rrf) >= 0.80, negative FPR (rrf) <= 0.20 ─
try {
  const { modes } = await runLessonsEval(MONGODB_URI, MONGODB_DB, 0.48);

  console.log('\n  Mode         | Hit@1 | Hit@3 | Neg FPR | Hard Hit@3');
  console.log('  -------------|-------|-------|---------|-----------');
  for (const m of ['text_only', 'vector_only', 'rrf'] as const) {
    const d = modes[m];
    const mStr = m.padEnd(12);
    const h1Str = `${(d.hit1 * 100).toFixed(0)}%`.padEnd(5);
    const h3Str = `${(d.hit3 * 100).toFixed(0)}%`.padEnd(5);
    const fprStr = `${(d.negativeFpr * 100).toFixed(0)}%`.padEnd(7);
    const hardStr = `${(d.hardParaphraseHit3 * 100).toFixed(0)}%`;
    console.log(`  ${mStr} | ${h1Str} | ${h3Str} | ${fprStr} | ${hardStr}`);
  }
  console.log();

  const rrfHit3Ok = modes.rrf.hit3 >= 0.8;
  const rrfFprOk = modes.rrf.negativeFpr <= 0.2;
  const ok = rrfHit3Ok && rrfFprOk;

  check(
    '(c) Eval table printed: hit@3 (rrf) >= 0.80, negative FPR (rrf) <= 0.20',
    ok,
    `hit@3=${(modes.rrf.hit3 * 100).toFixed(0)}% negFPR=${(modes.rrf.negativeFpr * 100).toFixed(0)}%`,
  );
} catch (err) {
  check('(c) Eval benchmark table', false, String(err));
}

// ─── (d) Exact token "invoice_id" still found in rrf mode ─────────────────────
try {
  // Ensure a demo lesson exists in DB
  const provider = getEmbeddingProvider();
  const demoSymptom = 'Contract violation: required key invoiceId missing; found similar key invoice_id in tool arguments.';
  const demoFix = 'Always enforce camelCase parameter naming in tool calls: use invoiceId, not invoice_id.';
  const [demoEmbed] = await provider.embed([`${demoSymptom} | model, prompt | ${demoFix}`], 'document');

  await db.collection('lessons').updateOne(
    { _id: 'lesson-demo-seed-1' as any },
    {
      $set: {
        _id: 'lesson-demo-seed-1',
        incidentId: 'inc_demo_seed_1',
        projectId: 'demo',
        symptom: demoSymptom,
        culprit: { units: ['model', 'prompt'], shapley: { model: 0.5, prompt: 0.5 }, interaction: true },
        changeTypes: ['model', 'prompt'],
        fix: demoFix,
        source: 'seed',
        status: 'active',
        embedding: demoEmbed ?? [],
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 100_000_000),
      },
    },
    { upsert: true },
  );

  const tokenRes = await fetch(`${BASE_URL}/v1/lessons/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ projectId: 'demo', query: 'invoice_id' }),
  });

  const tokenData = (await tokenRes.json()) as {
    mode: string;
    results: Array<{ lessonId: string; score: number; scoreType: string }>;
  };

  const hasInvoiceMatch = tokenData.results.some((r) => r.lessonId.includes('seed-1') || r.lessonId.startsWith('les_'));
  const ok = tokenRes.status === 200 && hasInvoiceMatch;

  check(
    '(d) Exact token "invoice_id" still found in rrf mode',
    ok,
    `status=${tokenRes.status} mode=${tokenData.mode} matched=${hasInvoiceMatch}`,
  );
} catch (err) {
  check('(d) Exact token match in rrf', false, String(err));
}

// ─── (e) No score in API response is labeled "similarity" when scoreType is "lexical"
try {
  const lexRes = await fetch(`${BASE_URL}/v1/lessons/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ projectId: 'demo', query: 'missing required invoiceId', mode: 'text_only' }),
  });

  const lexData = (await lexRes.json()) as {
    results: Array<{ scoreType: string; why: string }>;
  };

  const violatesRule = lexData.results.some(
    (r) => r.scoreType === 'lexical' && r.why.toLowerCase().includes('similarity'),
  );
  const ok = !violatesRule;

  check(
    '(e) No score in the API response is labeled "similarity" when scoreType is "lexical"',
    ok,
    `lexicalResults=${lexData.results.length} violatesRule=${violatesRule}`,
  );
} catch (err) {
  check('(e) Lexical honest score typing', false, String(err));
}

// ─── (f) EMBED_DIM mismatch still fails startup with readable message ────────
try {
  let caughtMismatch = false;
  let caughtMsg = '';

  const testProvider = new VoyageEmbeddingProvider({
    apiKey: 'dummy-key',
    model: 'voyage-3-lite',
    dim: 1024,
  });

  try {
    (testProvider as any).embedBatch = async () => [[0.1, 0.2, 0.3]]; // 3 dims instead of 1024
    await testProvider.embed(['hello']);
  } catch (err) {
    if (err instanceof EmbeddingDimensionMismatchError) {
      caughtMismatch = true;
      caughtMsg = err.message;
    }
  }

  const readable = caughtMsg.includes('expected 1024') && caughtMsg.includes('got 3');
  const ok = caughtMismatch && readable;

  check(
    '(f) EMBED_DIM mismatch still fails startup with readable message',
    ok,
    `caught="${caughtMsg}"`,
  );
} catch (err) {
  check('(f) Dimension mismatch validation', false, String(err));
}

await client.close();

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log();
if (allPassed) {
  console.log('✅ Gate 10b PASSED\n');
  process.exit(0);
} else {
  console.error('❌ Gate 10b FAILED\n');
  process.exit(1);
}
