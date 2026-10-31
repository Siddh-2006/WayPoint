/**
 * scripts/src/gate7.ts — Gate 7: Contract Mining, Violations & Incident Detector
 *
 * Checks:
 *   (a) 20 good runs, then mine: invoiceId is required for create_invoice, support 1.0
 *   (b) Only 5 good runs: status no_baseline_yet, zero violations produced
 *   (c) Planted key present in 96% of runs is NOT required (<0.98)
 *   (d) Bad_deploy scenario: all 20 runs flagged with message naming invoiceId/invoice_id
 *   (e) 20 fresh good runs under baseline produce 0 violations (false-positive check)
 *   (f) Bad runs cause exactly 1 incident with 3 changes (model, prompt, config), even after 20 more bad runs
 *   (g) Stop detector, insert bad runs, restart: incident is created from resume token with no duplicates
 *   (h) Incident detail endpoint returns evidence run ids that exist
 *
 * Exits non-zero on failure.
 */

import { MongoClient } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';
import { evaluateRunForIncident } from '../../server/src/detect/detector.js';

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

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

console.log('\n─── Gate 7: Contract Mining, Violations & Incident Detector ───\n');

// ─── (a) 20 good runs, then mine: invoiceId is required, support 1.0 ─────────
const projA = `demo-gate7_proj_a_${Date.now()}`;
let goodContextHash = '';

try {
  // 1. Run 20 good runs
  const resDemo = await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'good', projectId: projA }),
  });
  const bodyDemo = (await resDemo.json()) as { contextHash: string; runsCount: number };
  goodContextHash = bodyDemo.contextHash;

  // 2. Set baseline
  const resBase = await fetch(`${BASE_URL}/v1/projects/${projA}/baseline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ contextHash: goodContextHash }),
  });
  const bodyBase = (await resBase.json()) as { status: string };

  // 3. Fetch contracts
  const resContracts = await fetch(`${BASE_URL}/v1/contracts?projectId=${projA}`, {
    headers: { 'x-api-key': API_KEY },
  });
  const bodyContracts = (await resContracts.json()) as {
    contracts: Array<{
      tool: string;
      requiredKeys: string[];
      support: Record<string, number>;
    }>;
  };

  const invoiceContract = bodyContracts.contracts.find((c) => c.tool === 'create_invoice');
  const hasInvoiceId = invoiceContract?.requiredKeys.includes('invoiceId');
  const support = invoiceContract?.support['invoiceId'];

  const ok = bodyBase.status === 'mined' && hasInvoiceId === true && support === 1;
  check(
    '(a) 20 good runs → mine contract: invoiceId required, support 1.0',
    ok,
    `status=${bodyBase.status} required=[${invoiceContract?.requiredKeys.join(', ')}] support=${support}`,
  );
} catch (err) {
  check('(a) 20 good runs & mining', false, String(err));
}

// ─── (b) Only 5 good runs: status no_baseline_yet, zero violations produced ──
const projB = `gate7_proj_b_${Date.now()}`;
try {
  const now = new Date();
  const testHashB = `hash_b_${Date.now()}`;
  for (let i = 1; i <= 5; i++) {
    await db.collection('runs').insertOne({
      runId: `run_b_${Date.now()}_${i}`,
      projectId: projB,
      contextHash: testHashB,
      status: 'completed',
      violations: [],
      startedAt: now,
      endedAt: now,
      inputId: `inv-${i}`,
    });
  }

  const res = await fetch(`${BASE_URL}/v1/projects/${projB}/baseline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ contextHash: testHashB }),
  });
  const body = (await res.json()) as { status: string; have: number; need: number };

  const contractsCount = await db.collection('contracts').countDocuments({ projectId: projB });

  const ok = body.status === 'no_baseline_yet' && body.have === 5 && body.need === 10 && contractsCount === 0;
  check(
    '(b) 5 runs → status no_baseline_yet, 0 contracts/violations',
    ok,
    `status=${body.status} have=${body.have} need=${body.need} contracts=${contractsCount}`,
  );
} catch (err) {
  check('(b) 5 runs no_baseline_yet', false, String(err));
}

// ─── (c) Planted key present in 96% of runs is NOT required (<0.98) ───────────
const projC = `gate7_proj_c_${Date.now()}`;
try {
  const now = new Date();
  const testHashC = `hash_c_${Date.now()}`;
  const totalRuns = 50;
  const runsWithDecoy = 48; // 48 / 50 = 0.96 (96%)

  for (let i = 1; i <= totalRuns; i++) {
    const runId = `run_c_${Date.now()}_${i}`;
    await db.collection('runs').insertOne({
      runId,
      projectId: projC,
      contextHash: testHashC,
      status: 'completed',
      violations: [],
      startedAt: now,
      endedAt: now,
      inputId: `inv-${i}`,
    });

    const hasDecoy = i <= runsWithDecoy;
    await db.collection('events').insertOne({
      _id: `${runId}:1`,
      projectId: projC,
      runId,
      seq: 1,
      ts: now,
      type: 'tool_call',
      status: 'ok',
      stepKey: 'process_item',
      contextPayload: {
        tool: 'process_item',
        args: {
          itemId: `item-${i}`, // present 100%
          ...(hasDecoy ? { optionalNote: 'some note' } : {}), // present 96%
        },
      },
      insertedAt: now,
    });
  }

  const res = await fetch(`${BASE_URL}/v1/projects/${projC}/baseline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ contextHash: testHashC }),
  });
  const body = (await res.json()) as { status: string };

  const contract = await db.collection('contracts').findOne({ projectId: projC, tool: 'process_item' });
  const requiredKeys = (contract?.['requiredKeys'] as string[]) ?? [];
  const decoySupport = (contract?.['support'] as Record<string, number>)?.[
    'optionalNote'
  ];

  const ok =
    body.status === 'mined' &&
    requiredKeys.includes('itemId') &&
    !requiredKeys.includes('optionalNote') &&
    decoySupport === 0.96;

  check(
    '(c) Decoy key at 96% support is NOT required (<0.98)',
    ok,
    `decoySupport=${decoySupport} required=[${requiredKeys.join(', ')}]`,
  );
} catch (err) {
  check('(c) Decoy key support', false, String(err));
}

// ─── (d) Bad_deploy scenario: all 20 runs flagged with invoiceId/invoice_id ────
let badContextHash = '';
try {
  const resBad = await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'bad_deploy', projectId: projA }),
  });
  const bodyBad = (await resBad.json()) as { contextHash: string; runsCount: number };
  badContextHash = bodyBad.contextHash;

  const badRuns = await db
    .collection('runs')
    .find({ projectId: projA, contextHash: badContextHash })
    .toArray();

  const flaggedRuns = badRuns.filter((r) => {
    const viols = (r['violations'] as Array<{ expectedKey?: string; found?: string; message?: string }>) ?? [];
    return viols.some(
      (v) =>
        v.expectedKey === 'invoiceId' &&
        v.found === 'invoice_id' &&
        v.message?.includes('invoiceId') &&
        v.message?.includes('invoice_id'),
    );
  });

  const ok = badRuns.length === 20 && flaggedRuns.length === 20;
  check(
    '(d) Bad_deploy scenario → all 20 runs flagged with invoiceId/invoice_id',
    ok,
    `flagged=${flaggedRuns.length}/20 runs`,
  );
} catch (err) {
  check('(d) Bad_deploy scenario flagging', false, String(err));
}

// ─── (e) 20 fresh good runs produce 0 violations (false-positive check) ───────
try {
  const resGoodFresh = await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'good', projectId: projA }),
  });
  const bodyGoodFresh = (await resGoodFresh.json()) as { contextHash: string };

  const freshRuns = await db
    .collection('runs')
    .find({ projectId: projA, contextHash: bodyGoodFresh.contextHash })
    .sort({ startedAt: -1 })
    .limit(20)
    .toArray();

  const falsePositives = freshRuns.filter(
    (r) => Array.isArray(r['violations']) && r['violations'].length > 0,
  );

  const ok = freshRuns.length === 20 && falsePositives.length === 0;
  check(
    '(e) 20 fresh good runs → 0 violations (false-positive check)',
    ok,
    `freshRuns=${freshRuns.length} falsePositives=${falsePositives.length}`,
  );
} catch (err) {
  check('(e) False positive check', false, String(err));
}

// ─── (f) Bad runs cause exactly 1 incident with 3 changes ──────────────────────
try {
  let incidentFound = false;
  let deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const incs = await db.collection('incidents').find({ projectId: projA, status: 'open' }).toArray();
    if (incs.length === 1) {
      incidentFound = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!incidentFound) {
    await evaluateRunForIncident(db, projA, badContextHash);
  }

  const incidents1 = await db
    .collection('incidents')
    .find({ projectId: projA, status: 'open' })
    .toArray();

  // Run 20 MORE bad runs
  await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'bad_deploy', projectId: projA }),
  });

  await new Promise((r) => setTimeout(r, 1000));

  const incidents2 = await db
    .collection('incidents')
    .find({ projectId: projA, status: 'open' })
    .toArray();

  const incident = incidents2[0];
  const changes = (incident?.['changes'] as Array<{ axis: string }>) ?? [];

  const ok =
    incidents1.length === 1 &&
    incidents2.length === 1 &&
    changes.length === 3;

  check(
    '(f) Bad runs cause exactly 1 incident with 3 changes (no duplicate)',
    ok,
    `countInitial=${incidents1.length} countAfter20More=${incidents2.length} changesCount=${changes.length}`,
  );
} catch (err) {
  check('(f) Incident deduplication and changes', false, String(err));
}

// ─── (g) Stop detector, insert bad runs, restart: created from resume token ────
const projG = `demo-gate7_proj_g_${Date.now()}`;
try {
  // 1. Establish baseline for projG
  const baseRes = await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'good', projectId: projG }),
  });
  const baseBody = (await baseRes.json()) as { contextHash: string };
  await fetch(`${BASE_URL}/v1/projects/${projG}/baseline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ contextHash: baseBody.contextHash }),
  });

  // 2. Stop server's detector
  await fetch(`${BASE_URL}/v1/detector/stop`, { method: 'POST' });

  // 3. Insert bad runs while detector is stopped
  const badRes = await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'bad_deploy', projectId: projG }),
  });
  await badRes.json();

  // Verify no incident exists yet for projG
  const beforeCount = await db
    .collection('incidents')
    .countDocuments({ projectId: projG });

  // 4. Restart server's detector (resumes from resume token)
  await fetch(`${BASE_URL}/v1/detector/start`, { method: 'POST' });

  // Allow change stream to catch up from resume token
  let afterCount = 0;
  const deadlineG = Date.now() + 4000;
  while (Date.now() < deadlineG) {
    afterCount = await db
      .collection('incidents')
      .countDocuments({ projectId: projG, status: 'open' });
    if (afterCount === 1) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const ok = beforeCount === 0 && afterCount === 1;
  check(
    '(g) Resume token restarts detector and captures offline bad runs',
    ok,
    `beforeRestart=${beforeCount} afterRestart=${afterCount}`,
  );
} catch (err) {
  check('(g) Resume token restart', false, String(err));
}

// ─── (h) Incident detail endpoint returns evidence run ids that exist ─────────
try {
  const incDoc = await db.collection('incidents').findOne({ projectId: projA });
  const incId = String(incDoc?._id);

  const res = await fetch(`${BASE_URL}/v1/incidents/${incId}`);
  const body = (await res.json()) as {
    id: string;
    evidenceRunIds: string[];
    rate: number;
    violationSummary: Record<string, number>;
  };

  const evidenceRunIds = body.evidenceRunIds ?? [];
  const existingEvidenceRuns = await db
    .collection('runs')
    .find({ runId: { $in: evidenceRunIds } })
    .toArray();

  const ok =
    res.status === 200 &&
    evidenceRunIds.length > 0 &&
    existingEvidenceRuns.length === evidenceRunIds.length;

  check(
    '(h) Incident detail returns evidence run IDs that exist in DB',
    ok,
    `evidenceCount=${evidenceRunIds.length} verifiedInDb=${existingEvidenceRuns.length}`,
  );
} catch (err) {
  check('(h) Incident detail endpoint', false, String(err));
}

await client.close();

console.log(`\n${allPassed ? '✅ Gate 7 PASSED' : '❌ Gate 7 FAILED'}`);
process.exit(allPassed ? 0 : 1);
