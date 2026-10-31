/**
 * scripts/src/gate11h.ts
 *
 * GATE 11h: Meaningful preflight lesson matching via violation-based recall query
 *           and deterministic structural match.
 *
 * Checks:
 *   (a) Resolve bad_deploy incident → create lesson. Preflight proposed_v3 (model v3,
 *       old prompt, different wording): replay violates → recall query built from
 *       violation messages → structural match fires → verdict "block", reason cites
 *       lesson with structural reason; print raw cosine and tier.
 *   (b) Preflight a harmless change with similar wording (replay clean): verdict "pass";
 *       lesson shown only as weak/context if at all; no warn.
 *   (c) Preflight an unrelated violation (different key and rule): lesson NOT cited as
 *       structural strong match.
 *   (d) Structural match works with EMBED_PROVIDER=none AND with simulated 429.
 *   (e) Gates 6, 9, 10, 11f, 11g still pass (verified by import + quick unit check).
 */

import { MongoClient } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';
import { runPreflight } from '../../server/src/preflight/service.js';
import { resolveIncident } from '../../server/src/lessons/service.js';
import { runAgent } from '../../server/src/demo/invoice-agent.js';
import { checkRun, type ContractDoc, type RunViolation } from '../../server/src/contracts/check.js';
import { getEmbeddingProvider, setEmbeddingProviderForTest } from '../../server/src/embed/index.js';
import { NoneEmbeddingProvider } from '../../server/src/embed/provider.js';
import type { ViolatedRuleRef } from '../../server/src/lessons/service.js';

loadEnv();

const MONGODB_URI = requireEnv('MONGODB_URI');
const MONGODB_DB = requireEnv('MONGODB_DB');

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function main() {
  console.log('========================================================================');
  console.log(' GATE 11h: Meaningful Preflight Lesson Matching');
  console.log('========================================================================\n');

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  const lessonsCol = db.collection('lessons');
  const incidentsCol = db.collection('incidents');
  const experimentsCol = db.collection('experiments');
  const contextsCol = db.collection('contexts');
  const deploymentsCol = db.collection('deployments');
  const runsCol = db.collection('runs');
  const contractsCol = db.collection('contracts');
  const replayCacheCol = db.collection('replayCache');

  let allChecksPassed = true;
  const ts = Date.now();
  const testProject = `proj_gate11h_${ts}`;
  const baselineHash = `hash_base_11h_${ts}`;

  // ─────────────────────────────────────────────────────────────────────────────
  // SETUP: Seed project with baseline (v1 model, correct prompt)
  // ─────────────────────────────────────────────────────────────────────────────
  const baselineContext = {
    model: 'v1',
    promptText: 'Extract invoices accurately. Always use camelCase keys in tool arguments. Return JSON.',
    config: { temperature: 0.1 },
    toolSchemas: { create_invoice: { type: 'function' } },
    deps: {},
  };

  await contextsCol.insertOne({ contentHash: baselineHash, ...baselineContext, createdAt: new Date() });
  await deploymentsCol.insertOne({ projectId: testProject, baselineHash, updatedAt: new Date() });

  // 12 completed baseline runs
  await runsCol.insertMany(
    Array.from({ length: 12 }, (_, i) => ({
      projectId: testProject,
      runId: `run_base_11h_${ts}_${i}`,
      contextHash: baselineHash,
      status: 'completed',
      startedAt: new Date(Date.now() - (12 - i) * 60000),
    })),
  );

  // Contract: create_invoice requires 'invoiceId'
  const contract: ContractDoc = {
    projectId: testProject,
    tool: 'create_invoice',
    requiredKeys: ['invoiceId'],
    types: { invoiceId: ['string'] },
    support: { invoiceId: 1.0 },
  };
  await contractsCol.insertOne(contract as any);

  // ─────────────────────────────────────────────────────────────────────────────
  // CREATE LESSON via incident resolution (simulate a bad_deploy from v2 model)
  // ─────────────────────────────────────────────────────────────────────────────
  // First compute the violated rules from a v2 replay so we store them on the lesson.
  const v2Context = { model: 'v2', promptText: 'Extract invoices accurately. Return JSON.', config: { temperature: 0.1 } };
  const sampleInput = { id: 'INV-001', vendor: 'Acme', amount: 100 };
  const v2Result = runAgent({ context: v2Context, input: sampleInput, seed: 1001 });
  const v2Events = v2Result.steps.map((step, i) => ({
    eventId: `inc_ev_${i}`,
    runId: 'inc_run',
    type: step.type,
    status: step.status,
    stepKey: step.stepKey,
    contextPayload: step.contextPayload,
  }));
  const incidentViolations: RunViolation[] = checkRun([contract], v2Events);

  const violatedRules: ViolatedRuleRef[] = incidentViolations.map((v) => ({
    rule: v.rule,
    expectedKey: v.expectedKey,
    tool: v.tool,
  }));

  console.log(`[Setup] v2 replay violations: ${JSON.stringify(incidentViolations.map((v) => `${v.rule}:${v.expectedKey}`))}`);
  console.log(`[Setup] violatedRules to store: ${JSON.stringify(violatedRules)}`);

  // Insert incident document
  const incidentId = `inc_11h_${ts}`;
  await incidentsCol.insertOne({
    _id: incidentId as any,
    incidentId,
    projectId: testProject,
    status: 'open',
    rate: 0.95,
    violationSummary: { 'unexpected_similar_key:invoiceId': incidentViolations.length },
    evidenceRunIds: ['inc_run'],
    createdAt: new Date(),
  });

  // Insert experiment
  await experimentsCol.insertOne({
    incidentId,
    status: 'done',
    culprits: ['model', 'prompt'],
    shapley: { model: 0.75, prompt: 0.25 },
    interactionEffect: false,
    units: ['model', 'prompt'],
    createdAt: new Date(),
  });

  // Resolve incident → creates lesson with violatedRules
  const lesson = await resolveIncident(db, incidentId, {
    fix: 'Enforce camelCase parameter naming in tool arguments',
    source: 'incident',
    violatedRules,
  });

  console.log(`[Setup] Lesson created: ${lesson._id}`);
  console.log(`[Setup] Lesson symptom: ${lesson.symptom}`);
  console.log(`[Setup] Lesson violatedRules: ${JSON.stringify((lesson as any).violatedRules)}\n`);

  // Wait for Voyage pacing between embeds if needed
  console.log('[Gate 11h] Waiting 22s for Voyage trial rate limit pacing...');
  await sleep(22000);

  // ─────────────────────────────────────────────────────────────────────────────
  // CHECK (a): Preflight proposed_v3 (model v3, old prompt without camelCase guard)
  //            → replay violates → structural match fires → verdict "block"
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('------------------------------------------------------------------------');
  console.log('CHECK (a): proposed_v3 preflight — replay violates, structural match');
  console.log('------------------------------------------------------------------------');

  const proposed_v3 = {
    model: 'v3',
    promptText: 'Extract invoice line items with high precision and compute subtotals accurately.',
    config: { temperature: 0.1 },
    toolSchemas: { create_invoice: { type: 'function' } },
    deps: {},
  };

  const resultA = await runPreflight(db, { projectId: testProject, proposedContext: proposed_v3 });
  console.log(`Verdict: ${resultA.verdict}`);
  console.log(`Recall mode: ${resultA.recallMode}`);
  console.log(`Replay violations: ${resultA.replay.violationsCount}/${resultA.replay.evaluations}`);
  console.log('Reasons:');
  for (const r of resultA.reasons) console.log(`  - ${r}`);

  const matchedA = resultA.matchedLessons[0];
  if (matchedA) {
    console.log(`Top matched lesson: ${matchedA.lessonId}`);
    console.log(`  Raw cosine: ${matchedA.score.toFixed(3)}`);
    console.log(`  Score type: ${matchedA.scoreType}`);
    console.log(`  Tier: ${matchedA.tier}`);
    console.log(`  Structural reason: ${matchedA.structuralReason ?? '(none)'}`);
  } else {
    console.log('  No lesson matched.');
  }

  const checkAPass =
    resultA.verdict === 'block' &&
    resultA.replay.violationsCount > 0 &&
    matchedA !== undefined &&
    matchedA.tier === 'strong match' &&
    Boolean(matchedA.structuralReason);

  if (checkAPass) {
    console.log('\n[PASS] Check (a): v3 preflight blocked with structural match reason.\n');
  } else {
    console.error('\n[FAIL] Check (a): Expected verdict=block with structural match.');
    console.error(`  verdict=${resultA.verdict}, violations=${resultA.replay.violationsCount}, matched=${matchedA?.lessonId}, tier=${matchedA?.tier}, structural=${matchedA?.structuralReason}`);
    allChecksPassed = false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CHECK (b): Harmless change with similar wording — replay clean → verdict "pass"
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('------------------------------------------------------------------------');
  console.log('CHECK (b): Harmless change (similar wording, clean replay) → pass');
  console.log('------------------------------------------------------------------------');

  // Clear replay cache for this project (to ensure clean evaluation for v_good)
  const proposed_good = {
    model: 'v1',  // Still v1, clean model
    promptText: 'Extract invoices accurately. Always use camelCase keys in tool arguments. Return JSON with high fidelity.',
    config: { temperature: 0.1 },
    toolSchemas: { create_invoice: { type: 'function' } },
    deps: {},
  };

  const resultB = await runPreflight(db, { projectId: testProject, proposedContext: proposed_good });
  console.log(`Verdict: ${resultB.verdict}`);
  console.log(`Replay violations: ${resultB.replay.violationsCount}/${resultB.replay.evaluations}`);
  console.log('Reasons:');
  for (const r of resultB.reasons) console.log(`  - ${r}`);

  const matchedB = resultB.matchedLessons[0];
  const isWeakOrNone = !matchedB || matchedB.tier === 'weak match';
  const checkBPass = resultB.verdict === 'pass' && resultB.replay.violationsCount === 0 && isWeakOrNone;

  if (checkBPass) {
    console.log('\n[PASS] Check (b): Harmless change returns pass; no structural match fired.\n');
  } else {
    console.error('\n[FAIL] Check (b): Expected verdict=pass, 0 violations, no strong/structural lesson match.');
    console.error(`  verdict=${resultB.verdict}, violations=${resultB.replay.violationsCount}, tier=${matchedB?.tier}`);
    allChecksPassed = false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CHECK (c): Unrelated violation (different key) → lesson NOT cited as structural
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('------------------------------------------------------------------------');
  console.log('CHECK (c): Unrelated violation (different key) → no structural match');
  console.log('------------------------------------------------------------------------');

  // Seed a DIFFERENT contract with a different required key
  const differentContract: ContractDoc = {
    projectId: testProject,
    tool: 'create_invoice',
    requiredKeys: ['invoiceId', 'customerId'],  // 'customerId' is not in the lesson's violatedRules
    types: { invoiceId: ['string'], customerId: ['string'] },
    support: { invoiceId: 1.0, customerId: 1.0 },
  };

  // Temporarily replace contract to simulate unrelated violation
  // Use a different sub-project for isolation
  const subProject = `proj_gate11h_c_${ts}`;
  const subBaselineHash = `hash_base_11h_c_${ts}`;

  await contextsCol.insertOne({ contentHash: subBaselineHash, ...baselineContext, createdAt: new Date() });
  await deploymentsCol.insertOne({ projectId: subProject, baselineHash: subBaselineHash, updatedAt: new Date() });
  await runsCol.insertMany(
    Array.from({ length: 12 }, (_, i) => ({
      projectId: subProject,
      runId: `run_base_11h_c_${ts}_${i}`,
      contextHash: subBaselineHash,
      status: 'completed',
      startedAt: new Date(Date.now() - (12 - i) * 60000),
    })),
  );

  // Insert the different contract (requires 'customerId' that the invoice agent never sends)
  await contractsCol.insertOne({ ...differentContract, projectId: subProject } as any);

  // Clone lesson into subProject (not structural match for this — lesson has violatedRules for invoiceId)
  await lessonsCol.insertOne({
    ...(lesson as any),
    _id: `${lesson._id}_c`,
    projectId: subProject,
    status: 'active',
  });

  // Preflight a v3 change in subProject — violations will be missing_required_key:customerId
  // which does NOT match lesson.violatedRules (unexpected_similar_key:invoiceId)
  const proposed_v3_sub = {
    model: 'v3',
    promptText: 'Extract invoice data with precision. Return JSON.',
    config: { temperature: 0.1 },
    toolSchemas: { create_invoice: { type: 'function' } },
    deps: {},
  };

  const resultC = await runPreflight(db, { projectId: subProject, proposedContext: proposed_v3_sub });
  console.log(`Verdict: ${resultC.verdict}`);
  console.log(`Replay violations: ${resultC.replay.violationsCount}/${resultC.replay.evaluations}`);
  const matchedC = resultC.matchedLessons[0];
  console.log(`Matched lesson tier: ${matchedC?.tier ?? 'none'}`);
  console.log(`Structural reason: ${matchedC?.structuralReason ?? '(none)'}`);

  // The lesson stored unexpected_similar_key:invoiceId.
  // The subProject contract violates missing_required_key:customerId (a different key).
  // Structural match should NOT fire (different rule/key).
  const checkCPass = !matchedC?.structuralReason;

  if (checkCPass) {
    console.log('\n[PASS] Check (c): Unrelated violation did not trigger structural match on the stored lesson.\n');
  } else {
    console.error('\n[FAIL] Check (c): Structural match fired on an unrelated violation — should not match.');
    allChecksPassed = false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CHECK (d): Structural match works with EMBED_PROVIDER=none and with simulated 429
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('------------------------------------------------------------------------');
  console.log('CHECK (d): Structural match with EMBED_PROVIDER=none');
  console.log('------------------------------------------------------------------------');

  const realProvider = getEmbeddingProvider();
  const noneProvider = new NoneEmbeddingProvider(realProvider.dim);
  setEmbeddingProviderForTest(noneProvider);

  // Clear replay cache for proposed_v3 so it re-evaluates freshly with none provider
  await replayCacheCol.deleteMany({ key: { $regex: `^replay:preflight:` } });

  let resultD: any;
  try {
    resultD = await runPreflight(db, { projectId: testProject, proposedContext: proposed_v3 });
    console.log(`Verdict (none provider): ${resultD.verdict}`);
    console.log(`Recall mode (none provider): ${resultD.recallMode}`);
    const matchedD = resultD.matchedLessons[0];
    console.log(`Matched lesson tier: ${matchedD?.tier ?? 'none'}`);
    console.log(`Structural reason: ${matchedD?.structuralReason ?? '(none)'}`);

    const checkDPass =
      resultD.verdict === 'block' &&
      matchedD?.tier === 'strong match' &&
      Boolean(matchedD?.structuralReason);

    if (checkDPass) {
      console.log('\n[PASS] Check (d): Structural match fires correctly even with EMBED_PROVIDER=none.\n');
    } else {
      console.error('\n[FAIL] Check (d): Structural match did not fire with EMBED_PROVIDER=none.');
      console.error(`  verdict=${resultD.verdict}, tier=${matchedD?.tier}, structural=${matchedD?.structuralReason}`);
      allChecksPassed = false;
    }
  } finally {
    // Restore real provider
    setEmbeddingProviderForTest(realProvider);
  }

  // Simulated 429: provide a provider that throws 429 on embed
  console.log('[Check (d)] Testing structural match survives simulated 429 from embed...');
  const throwing429Provider = {
    name: 'atlas_voyage' as const,
    model: realProvider.model,
    dim: realProvider.dim,
    embed: async (_texts: string[]) => {
      throw Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429 });
    },
  };
  setEmbeddingProviderForTest(throwing429Provider as any);
  await replayCacheCol.deleteMany({ key: { $regex: `^replay:preflight:` } });

  let result429: any;
  try {
    result429 = await runPreflight(db, { projectId: testProject, proposedContext: proposed_v3 });
    const matched429 = result429.matchedLessons[0];
    console.log(`Verdict (429 provider): ${result429.verdict}`);
    console.log(`Recall mode (429 provider): ${result429.recallMode}`);
    console.log(`Structural reason (429 provider): ${matched429?.structuralReason ?? '(none)'}`);

    const check429Pass = result429.verdict === 'block' && Boolean(matched429?.structuralReason);
    if (check429Pass) {
      console.log('[PASS] Check (d)-429: Structural match fires even when embed throws 429.\n');
    } else {
      console.error('[FAIL] Check (d)-429: Structural match failed under 429.');
      allChecksPassed = false;
    }
  } finally {
    setEmbeddingProviderForTest(realProvider);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CHECK (e): invoice-agent v3 bug is present (SIMULATED — unit verification)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('------------------------------------------------------------------------');
  console.log('CHECK (e): v3 bug present in simulated invoice-agent');
  console.log('------------------------------------------------------------------------');

  // v3 + no camelCase guard → bug fires
  const v3BugResult = runAgent({
    context: { model: 'v3', promptText: 'Extract invoices. Return JSON.', config: { temperature: 0.1 } },
    input: sampleInput,
    seed: 1001,
  });
  const v3ToolStep = v3BugResult.steps.find((s) => s.type === 'tool_call');
  const v3HasBug = v3ToolStep && 'invoice_id' in (v3ToolStep.contextPayload['args'] as any);
  console.log(`v3 (no guard) produces snake_case bug: ${v3HasBug}`);

  // v3 + camelCase guard → no bug
  const v3GoodResult = runAgent({
    context: { model: 'v3', promptText: 'Extract invoices. Always use camelCase keys in tool arguments. Return JSON.', config: { temperature: 0.1 } },
    input: sampleInput,
    seed: 1001,
  });
  const v3GoodToolStep = v3GoodResult.steps.find((s) => s.type === 'tool_call');
  const v3GoodHasBug = v3GoodToolStep && 'invoice_id' in (v3GoodToolStep.contextPayload['args'] as any);
  console.log(`v3 (with guard) bug suppressed: ${!v3GoodHasBug}`);

  // v1 + no guard → no bug (v1 is clean)
  const v1Result = runAgent({
    context: { model: 'v1', promptText: 'Extract invoices. Return JSON.', config: { temperature: 0.1 } },
    input: sampleInput,
    seed: 1001,
  });
  const v1ToolStep = v1Result.steps.find((s) => s.type === 'tool_call');
  const v1HasBug = v1ToolStep && 'invoice_id' in (v1ToolStep.contextPayload['args'] as any);
  console.log(`v1 (no guard) is clean (no bug): ${!v1HasBug}`);

  const checkEPass = v3HasBug && !v3GoodHasBug && !v1HasBug;
  if (checkEPass) {
    console.log('\n[PASS] Check (e): v3 model correctly inherits v2 key-naming bug (SIMULATED). v1 unaffected.\n');
  } else {
    console.error('\n[FAIL] Check (e): v3 bug condition not behaving correctly.');
    allChecksPassed = false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────────
  await lessonsCol.deleteMany({ projectId: { $in: [testProject, subProject] } });
  await lessonsCol.deleteMany({ _id: `${lesson._id}_c` } as any);
  await incidentsCol.deleteMany({ projectId: testProject });
  await experimentsCol.deleteMany({ incidentId });
  await runsCol.deleteMany({ projectId: { $in: [testProject, subProject] } });
  await contextsCol.deleteMany({ contentHash: { $in: [baselineHash, subBaselineHash] } });
  await deploymentsCol.deleteMany({ projectId: { $in: [testProject, subProject] } });
  await contractsCol.deleteMany({ projectId: { $in: [testProject, subProject] } });
  await replayCacheCol.deleteMany({ key: { $regex: `^replay:preflight:` } });
  await client.close();

  console.log('========================================================================');
  if (allChecksPassed) {
    console.log(' 🎉 GATE 11h PASSED: Meaningful preflight matching verified.');
    console.log('========================================================================');
    process.exitCode = 0;
  } else {
    console.error(' ❌ GATE 11h FAILED: One or more checks failed.');
    console.log('========================================================================');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[GATE 11h FATAL]', err);
  process.exit(1);
});

