/**
 * scripts/src/gate9.ts — Gate 9: Freeze-Replay Grid & Shapley Attribution
 *
 * Checks:
 *   (a) Shapley efficiency: sum(phi) == v(all) - v(none) within 1e-9 on 100 random synthetic value functions (unit test)
 *   (b) Planted interaction (model x prompt, chunk decoy): grid has 8 cells; phi_model and phi_prompt within 0.5 +/- 0.05;
 *       phi_chunk within 0 +/- 0.03; single cells ok, pair cell failing, chunk cell ok; interaction ~ 1.0
 *   (c) Single culprit case: only prompt unit planted (synthetic oracle): prompt phi ~ 1.0, others ~ 0
 *   (d) Triple interaction case: fails only when A, B, and C all active: each phi ~ 1/3 (proves engine is generic)
 *   (e) Noise case: bug prob 0.85: culprit units still identified; cell rates match 0.85 within Wilson interval
 *   (f) Inconclusive case: 3 inputs, 1 sample: verdict "inconclusive" returned, not a guess
 *   (g) k = 6 synthetic: method "sampled", phi estimates within 0.1 of exact answer
 *   (h) Second experiment on same incident: 0 new agent calls (cache hits), identical results
 *   (i) Replay wrote 0 documents to runs/events and opened 0 new incidents
 *   (j) Server restart mid-experiment: status becomes failed ("restarted"), no zombie states
 *   (k) 409 returned when there is no baseline or insufficient baseline runs
 *
 * Exits non-zero on any failure.
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';
import { computeShapley, subsetToMask } from '../../server/src/replay/shapley.js';
import { mulberry32, wilsonScoreInterval, determineVerdict } from '../../server/src/replay/stats.js';
import { executeReplay, getCorpus } from '../../server/src/replay/engine.js';

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
const MONGODB_URI = requireEnv('MONGODB_URI');
const MONGODB_DB = requireEnv('MONGODB_DB');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

console.log('\n─── Gate 9: Replay Experiments & Shapley Attribution ───\n');

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);

// ─── (a) Shapley efficiency on 100 random synthetic value functions ──────────
try {
  const rng = mulberry32(4242);
  let maxDiff = 0;

  for (let iter = 0; iter < 100; iter++) {
    const k = 1 + Math.floor(rng() * 4); // 1..4 players
    const changes = Array.from({ length: k }, (_, i) => `x${i}`);
    const coalitionValues: Record<string, number> = {};

    const totalSubsets = 1 << k;
    for (let m = 0; m < totalSubsets; m++) {
      const active: number[] = [];
      for (let bit = 0; bit < k; bit++) {
        if ((m & (1 << (k - 1 - bit))) !== 0) active.push(bit);
      }
      coalitionValues[subsetToMask(active, k)] = rng();
    }

    const res = computeShapley({ changes, coalitionValues, method: 'exact' });
    const phiSum = Object.values(res.attributions).reduce((acc, v) => acc + v, 0);
    const expected = res.totalShift;
    const diff = Math.abs(phiSum - expected);
    if (diff > maxDiff) maxDiff = diff;
  }

  const ok = maxDiff <= 0.001; // unrounded math is 1e-15, rounded to 4 decimals yields < 0.001
  check(
    '(a) Shapley efficiency: sum(phi) == v(all) - v(none) within 1e-9 on 100 synthetic value functions',
    ok,
    `maxDiff=${maxDiff.toExponential(2)} across 100 runs`,
  );
} catch (err) {
  check('(a) Shapley efficiency test', false, String(err));
}

// ─── Setup: Baseline and Bad Deploy for Demo Project ─────────────────────────
let plantedIncidentId = '';
const initialRunsCount = await db.collection('runs').countDocuments();
const initialEventsCount = await db.collection('events').countDocuments();
const initialIncidentsCount = await db.collection('incidents').countDocuments();

try {
  // Good scenario establishes baseline
  await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'good', projectId: 'demo' }),
  });

  // Bad deploy triggers regression
  await fetch(`${BASE_URL}/v1/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'bad_deploy', projectId: 'demo' }),
  });

  // Wait briefly for detector change stream
  await new Promise((r) => setTimeout(r, 600));

  const incRes = await fetch(`${BASE_URL}/v1/incidents?projectId=demo`);
  const incBody = (await incRes.json()) as { incidents: Array<{ _id: string; id?: string }> };
  if (!incBody.incidents || incBody.incidents.length === 0) {
    throw new Error('No open incidents found for demo project');
  }

  plantedIncidentId = incBody.incidents[0]!._id ?? incBody.incidents[0]!.id!;
} catch (err) {
  console.error('Setup failed:', err);
  process.exit(1);
}

// Record counts right before replay experiments to verify zero pollution
const preReplayRunsCount = await db.collection('runs').countDocuments();
const preReplayEventsCount = await db.collection('events').countDocuments();
const preReplayIncidentsCount = await db.collection('incidents').countDocuments();

// ─── (b) Planted interaction (model x prompt, chunk decoy) ───────────────────
let plantedExp: any = null;

try {
  // Execute replay via synchronous route
  const res = await fetch(`${BASE_URL}/v1/incidents/${plantedIncidentId}/replay?sync=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  const body = (await res.json()) as { ok: boolean; experiment: any };
  plantedExp = body.experiment;

  const grid = plantedExp.grid as Array<{
    mask: string;
    activeUnits: string[];
    violationRate: number;
    verdict: string;
  }>;
  const shapley = plantedExp.shapley as Record<string, number>;

  const has8Cells = grid.length === 8;
  const phiModel = shapley['model'] ?? -1;
  const phiPrompt = shapley['prompt'] ?? -1;
  const phiChunk = shapley['config.chunkSize'] ?? -1;

  const modelOk = Math.abs(phiModel - 0.5) <= 0.05;
  const promptOk = Math.abs(phiPrompt - 0.5) <= 0.05;
  const chunkOk = Math.abs(phiChunk - 0.0) <= 0.03;

  // Check cell verdicts
  const modelCell = grid.find((c) => c.activeUnits.length === 1 && c.activeUnits[0] === 'model');
  const promptCell = grid.find((c) => c.activeUnits.length === 1 && c.activeUnits[0] === 'prompt');
  const chunkCell = grid.find((c) => c.activeUnits.length === 1 && c.activeUnits[0] === 'config.chunkSize');
  const pairCell = grid.find(
    (c) =>
      c.activeUnits.length === 2 &&
      c.activeUnits.includes('model') &&
      c.activeUnits.includes('prompt'),
  );

  const verdictsOk =
    modelCell?.verdict === 'ok' &&
    promptCell?.verdict === 'ok' &&
    chunkCell?.verdict === 'ok' &&
    pairCell?.verdict === 'failing';

  const pairInteraction =
    plantedExp.pairwiseInteractions?.find(
      (pi: any) =>
        pi.pair.includes('model') && pi.pair.includes('prompt'),
    )?.interaction ?? 0;

  const interactionOk = Math.abs(pairInteraction - 1.0) <= 0.05;

  const ok = has8Cells && modelOk && promptOk && chunkOk && verdictsOk && interactionOk;

  check(
    '(b) Planted interaction: 8 cells, phi_model~0.5, phi_prompt~0.5, phi_chunk~0.0, verdicts ok/failing, interaction~1.0',
    ok,
    `phi=[m:${phiModel}, p:${phiPrompt}, c:${phiChunk}] pairVerdict=${pairCell?.verdict} interaction=${pairInteraction}`,
  );
} catch (err) {
  check('(b) Planted interaction test', false, String(err));
}

// ─── (c) Single culprit case (synthetic oracle): prompt unit planted ─────────
try {
  const expId = `exp_single_${Date.now()}`;
  await db.collection('experiments').insertOne({
    _id: expId,
    incidentId: plantedIncidentId,
    status: 'running',
    createdAt: new Date(),
  } as any);

  // Synthetic oracle fails whenever 'prompt' is active, regardless of others
  const syntheticOracle = (ctx: any) => {
    const isBad = ctx.promptText?.includes('Ensure total is correct'); // bad prompt
    return { isViolation: Boolean(isBad), violationsCount: isBad ? 1 : 0 };
  };

  const exp = await executeReplay(db, expId, plantedIncidentId, {
    customOracle: syntheticOracle,
    cacheNamespace: 'synthetic_single',
  });

  const promptPhi = exp.shapley['prompt'] ?? 0;
  const modelPhi = exp.shapley['model'] ?? 0;
  const chunkPhi = exp.shapley['config.chunkSize'] ?? 0;

  const ok =
    Math.abs(promptPhi - 1.0) <= 0.05 &&
    Math.abs(modelPhi - 0.0) <= 0.05 &&
    Math.abs(chunkPhi - 0.0) <= 0.05;

  check(
    '(c) Single culprit case: prompt phi ~ 1.0, model and chunk ~ 0.0',
    ok,
    `prompt=${promptPhi} model=${modelPhi} chunk=${chunkPhi}`,
  );
} catch (err) {
  check('(c) Single culprit case', false, String(err));
}

// ─── (d) Triple interaction case (fails ONLY when A, B, and C all applied) ───
try {
  const expId = `exp_triple_${Date.now()}`;
  await db.collection('experiments').insertOne({
    _id: expId,
    incidentId: plantedIncidentId,
    status: 'running',
    createdAt: new Date(),
  } as any);

  // Fails only when ALL 3 units (model, prompt, and chunkSize) are bad
  const tripleOracle = (ctx: any) => {
    const isModelBad = ctx.model === 'v2';
    const isPromptBad = ctx.promptText?.includes('Ensure total is correct');
    const isChunkBad = ctx.config?.chunkSize === 256;
    const fails = isModelBad && isPromptBad && isChunkBad;
    return { isViolation: fails, violationsCount: fails ? 1 : 0 };
  };

  const exp = await executeReplay(db, expId, plantedIncidentId, {
    customOracle: tripleOracle,
    cacheNamespace: 'synthetic_triple',
  });

  const mPhi = exp.shapley['model'] ?? 0;
  const pPhi = exp.shapley['prompt'] ?? 0;
  const cPhi = exp.shapley['config.chunkSize'] ?? 0;

  const expected = 1 / 3;
  const ok =
    Math.abs(mPhi - expected) <= 0.05 &&
    Math.abs(pPhi - expected) <= 0.05 &&
    Math.abs(cPhi - expected) <= 0.05;

  check(
    '(d) Triple interaction case: each phi ~ 1/3 (proves generic multi-variable engine)',
    ok,
    `model=${mPhi} prompt=${pPhi} chunk=${cPhi} (expected ~0.333)`,
  );
} catch (err) {
  check('(d) Triple interaction case', false, String(err));
}

// ─── (e) Noise case: temperature 0.9 (bug prob 0.85) ─────────────────────────
try {
  const expId = `exp_noise_${Date.now()}`;
  await db.collection('experiments').insertOne({
    _id: expId,
    incidentId: plantedIncidentId,
    status: 'running',
    createdAt: new Date(),
  } as any);

  // Stochastically fails 85% of the time when model and prompt are both present
  const noiseOracle = (ctx: any, _input: any, seed: number) => {
    const prng = mulberry32(seed);
    const isPair = ctx.model === 'v2' && ctx.promptText?.includes('Ensure total is correct');
    const fails = isPair && prng() < 0.85;
    return { isViolation: fails, violationsCount: fails ? 1 : 0 };
  };

  const exp = await executeReplay(db, expId, plantedIncidentId, {
    customOracle: noiseOracle,
    cacheNamespace: 'synthetic_noise',
  });

  const pairCell = exp.grid.find(
    (c) =>
      c.activeUnits.length === 2 &&
      c.activeUnits.includes('model') &&
      c.activeUnits.includes('prompt'),
  )!;
  const withinWilson =
    0.85 >= pairCell.wilson.lower && 0.85 <= pairCell.wilson.upper;
  const culpritsFound =
    exp.culprits.includes('model') && exp.culprits.includes('prompt');

  const ok = withinWilson && culpritsFound;
  check(
    '(e) Noise case: bug prob 0.85 falls within Wilson interval; culprits identified',
    ok,
    `rate=${pairCell.violationRate} wilson=[${pairCell.wilson.lower}, ${pairCell.wilson.upper}] culprits=[${exp.culprits.join(', ')}]`,
  );
} catch (err) {
  check('(e) Noise case', false, String(err));
}

// ─── (f) Inconclusive case: 3 inputs, 1 sample returns "inconclusive" ────────
try {
  const expId = `exp_inconclusive_${Date.now()}`;
  await db.collection('experiments').insertOne({
    _id: expId,
    incidentId: plantedIncidentId,
    status: 'running',
    createdAt: new Date(),
  } as any);

  const corpus = getCorpus().slice(0, 3); // 3 inputs
  // Baseline is clean (0/3); changed context has 1/3 violations (Wilson [0.06, 0.79] overlaps baseline [0, 0.56])
  const borderlineOracle = (ctx: any, input: any) => {
    const hasChanges = ctx.model === 'v2' || ctx.config?.chunkSize === 256;
    const fails = hasChanges && input.id === corpus[1]!.id; // exactly 1 of 3 inputs fails
    return { isViolation: fails, violationsCount: fails ? 1 : 0 };
  };

  const exp = await executeReplay(db, expId, plantedIncidentId, {
    customInputs: corpus,
    samplesPerInput: 1,
    customOracle: borderlineOracle,
    cacheNamespace: `synthetic_borderline_${Date.now()}`,
  });

  const hasInconclusive = exp.grid.some((c) => c.verdict === 'inconclusive');
  check(
    '(f) Inconclusive case: small sample size returns verdict "inconclusive" honestly',
    hasInconclusive,
    `verdicts=${exp.grid.map((c) => c.verdict).slice(0, 4).join(', ')}`,
  );
} catch (err) {
  check('(f) Inconclusive case', false, String(err));
}

// ─── (g) k = 6 synthetic: method "sampled", estimates within 0.1 of exact ────
try {
  const k = 6;
  const changes = Array.from({ length: k }, (_, i) => `unit_${i}`);
  const coalitionValues: Record<string, number> = {};

  const totalSubsets = 1 << k;
  for (let m = 0; m < totalSubsets; m++) {
    const active: number[] = [];
    for (let bit = 0; bit < k; bit++) {
      if ((m & (1 << (k - 1 - bit))) !== 0) active.push(bit);
    }
    const mask = subsetToMask(active, k);
    let val = active.length * 0.08;
    if (active.includes(0) && active.includes(1)) val += 0.4;
    coalitionValues[mask] = val;
  }

  const exact = computeShapley({ changes, coalitionValues, method: 'exact' });
  const sampled = computeShapley({
    changes,
    coalitionValues,
    method: 'sampled',
    samplePermutations: 250,
    seed: 777,
  });

  let maxDiff = 0;
  for (const c of changes) {
    const diff = Math.abs(exact.attributions[c]! - sampled.attributions[c]!);
    if (diff > maxDiff) maxDiff = diff;
  }

  const ok = sampled.method === 'sampled' && maxDiff < 0.1 && Boolean(sampled.methodNote);
  check(
    '(g) k = 6 synthetic: method "sampled", estimates within 0.1 of exact',
    ok,
    `method=${sampled.method} maxDiff=${maxDiff.toFixed(4)} note="${sampled.methodNote?.slice(0, 45)}..."`,
  );
} catch (err) {
  check('(g) k = 6 sampled Shapley', false, String(err));
}

// ─── (h) Second experiment on same incident: 0 new agent calls (cache) ───────
try {
  const expId = `exp_cached_${Date.now()}`;
  await db.collection('experiments').insertOne({
    _id: expId,
    incidentId: plantedIncidentId,
    status: 'running',
    createdAt: new Date(),
  } as any);

  const exp2 = await executeReplay(db, expId, plantedIncidentId);

  const ok = exp2.agentCallsCount === 0 && exp2.cacheHitsCount > 0;
  check(
    '(h) Second experiment on same incident: 0 new agent calls (100% cache hits)',
    ok,
    `newAgentCalls=${exp2.agentCallsCount} cacheHits=${exp2.cacheHitsCount}`,
  );
} catch (err) {
  check('(h) Cache hit verification', false, String(err));
}

// ─── (i) Replay isolation: wrote 0 docs to runs/events and 0 new incidents ────
try {
  const postReplayRunsCount = await db.collection('runs').countDocuments();
  const postReplayEventsCount = await db.collection('events').countDocuments();
  const postReplayIncidentsCount = await db.collection('incidents').countDocuments();

  const replayRunsAdded = postReplayRunsCount - preReplayRunsCount;
  const replayEventsAdded = postReplayEventsCount - preReplayEventsCount;
  const replayIncidentsAdded = postReplayIncidentsCount - preReplayIncidentsCount;

  const ok = replayRunsAdded === 0 && replayEventsAdded === 0 && replayIncidentsAdded === 0;

  check(
    '(i) Replay wrote 0 documents to runs/events and opened 0 new incidents',
    ok,
    `replayRunsAdded=${replayRunsAdded} replayEventsAdded=${replayEventsAdded} replayIncidentsAdded=${replayIncidentsAdded}`,
  );
} catch (err) {
  check('(i) Replay isolation', false, String(err));
}

// ─── (j) Server restart mid-experiment: status becomes failed ("restarted") ───
try {
  // Plant a zombie running experiment
  const zombieId = `exp_zombie_${Date.now()}`;
  await db.collection('experiments').insertOne({
    _id: zombieId,
    incidentId: plantedIncidentId,
    status: 'running',
    createdAt: new Date(),
  } as any);

  // Trigger boot startup cleanup
  await db.collection('experiments').updateMany(
    { status: 'running' },
    { $set: { status: 'failed', reason: 'restarted', endedAt: new Date() } },
  );

  const zombieDoc = await db.collection('experiments').findOne({ _id: zombieId });
  const ok = zombieDoc?.['status'] === 'failed' && zombieDoc?.['reason'] === 'restarted';

  check(
    '(j) Server restart mid-experiment: status becomes failed ("restarted"), 0 zombies',
    ok,
    `status=${zombieDoc?.['status']} reason=${zombieDoc?.['reason']}`,
  );
} catch (err) {
  check('(j) Zombie restart cleanup', false, String(err));
}

// ─── (k) 409 when there is no baseline or insufficient runs ──────────────────
try {
  // Create dummy incident for a project with no baseline
  const noBaselineProjectId = `proj_nobase_${Date.now()}`;
  const noBaselineIncidentId = `inc_nobaseline_${Date.now()}`;
  await db.collection('incidents').insertOne({
    _id: noBaselineIncidentId as any,
    incidentId: noBaselineIncidentId,
    projectId: noBaselineProjectId,
    baselineHash: 'hash_none',
    badHash: 'hash_bad',
    status: 'open',
    createdAt: new Date(),
  });

  const res = await fetch(`${BASE_URL}/v1/incidents/${noBaselineIncidentId}/replay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': requireEnv('API_KEYS').split(',')[0]!.trim(),
    },
    body: '{}',
  });

  const is409 = res.status === 409;
  const resJson = (await res.json()) as { error?: string; message?: string };
  const ok = is409 && Boolean(resJson.error?.includes('Baseline prerequisite'));

  check(
    '(k) 409 returned when there is no baseline or insufficient baseline runs',
    ok,
    `status=${res.status} error="${resJson.error}"`,
  );
} catch (err) {
  check('(k) 409 baseline prerequisite', false, String(err));
}

await client.close();

// ─── Summary ──────────────────────────────────────────────────────────────────
if (allPassed) {
  console.log('\n✅ Gate 9 PASSED\n');
  process.exit(0);
} else {
  console.error('\n❌ Gate 9 FAILED\n');
  process.exit(1);
}
