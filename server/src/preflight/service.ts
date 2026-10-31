/**
 * server/src/preflight/service.ts
 *
 * Preflight verification engine.
 * Evaluates proposed context changes against live deployment:
 *   1. Diffs live baseline context vs proposed context
 *   2. Runs deterministic replay simulation over corpus (using replayCache, writing 0 docs to runs/events)
 *   3. Recalls episodic memory lessons matching the proposed diff
 *   4. Generates verdict:
 *        - 'block': if replay Wilson lower bound > EPSILON (reproducible violation confirmed)
 *        - 'warn':  if prior lesson matches (score >= LESSON_MIN_SCORE) OR replay is inconclusive
 *        - 'pass':  clean replay and no matching regression lessons
 *   5. Outputs compact plain text summary (<= 600 chars) for downstream LLM narration
 */

import type { Db } from 'mongodb';
import { config } from '../config.js';
import { diffContexts, type ContextChange } from '../contexts/diff.js';
import { hashContext, type ContextData } from '../contexts/hash.js';
import { extractUnits } from '../replay/units.js';
import { getCorpus, type ReplayCellStats } from '../replay/engine.js';
import { runAgent } from '../demo/invoice-agent.js';
import { checkRun, type ContractDoc } from '../contracts/check.js';
import { wilsonScoreInterval, determineVerdict, type WilsonInterval } from '../replay/stats.js';
import { recallLessons, type RecallResultItem } from '../lessons/recall.js';
import { BaselinePrerequisiteError } from '../replay/engine.js';

export interface PreflightResult {
  projectId: string;
  verdict: 'block' | 'warn' | 'pass';
  reasons: string[];
  summary: string;
  changes: ContextChange[];
  units: string[];
  replay: {
    evaluations: number;
    violationsCount: number;
    violationRate: number;
    wilson: WilsonInterval;
    verdict: string;
  };
  matchedLessons: RecallResultItem[];
  recallMode: string;
  timestamp: string;
}

export async function runPreflight(
  db: Db,
  options: {
    projectId: string;
    proposedContext: ContextData;
  },
): Promise<PreflightResult> {
  const { projectId, proposedContext } = options;
  const deploymentsCol = db.collection('deployments');
  const contextsCol = db.collection('contexts');
  const contractsCol = db.collection<ContractDoc>('contracts');
  const runsCol = db.collection('runs');
  const replayCacheCol = db.collection('replayCache');

  // 1. Verify baseline prerequisite
  const deployment = await deploymentsCol.findOne({ projectId });
  if (!deployment || !deployment['baselineHash']) {
    throw new BaselinePrerequisiteError(
      'Project has no baseline hash recorded on deployments',
      0,
      config.MIN_BASELINE_RUNS,
    );
  }

  const baselineHash = deployment['baselineHash'] as string;
  const baselineRunsCount = await runsCol.countDocuments({
    projectId,
    contextHash: baselineHash,
    status: 'completed',
  });

  if (baselineRunsCount < config.MIN_BASELINE_RUNS) {
    throw new BaselinePrerequisiteError(
      `Insufficient baseline runs for project ${projectId}`,
      baselineRunsCount,
      config.MIN_BASELINE_RUNS,
    );
  }

  // 2. Fetch baseline context
  const baselineDoc = await contextsCol.findOne({ contentHash: baselineHash });
  if (!baselineDoc) {
    throw new Error(`Baseline context doc not found for hash ${baselineHash}`);
  }

  const liveContext: ContextData = {
    model: baselineDoc['model'],
    promptText: baselineDoc['promptText'],
    config: baselineDoc['config'] ?? {},
    toolSchemas: baselineDoc['toolSchemas'] ?? {},
    deps: baselineDoc['deps'] ?? {},
  };

  // 3. Diff live context vs proposed context
  const changes = diffContexts(liveContext, proposedContext);
  const units = extractUnits(liveContext, proposedContext);

  // 4. Replay proposed context across corpus with memoization in replayCache
  const proposedHash = hashContext(proposedContext);
  const corpus = getCorpus();
  const contracts = await contractsCol.find({ projectId }).toArray();
  const samples = config.REPLAY_SAMPLES;
  const totalEvals = corpus.length * samples;
  let violationsCount = 0;

  for (let idx = 0; idx < corpus.length; idx++) {
    const input = corpus[idx]!;
    for (let s = 1; s <= samples; s++) {
      const numId = parseInt(input.id.replace(/\D/g, ''), 10) || (idx + 1);
      const seed = numId * 1000 + s;
      const cacheKey = `replay:preflight:${proposedHash}:${input.id}:${seed}:v1`;

      let isViolation = false;
      const cached = await replayCacheCol.findOne({ key: cacheKey });
      if (cached) {
        isViolation = Boolean(cached['isViolation']);
      } else {
        const result = runAgent({ context: proposedContext, input, seed });
        const checkEvents = result.steps.map((step, sIdx) => ({
          eventId: `preflight:${input.id}:${sIdx + 1}`,
          runId: `preflight:${input.id}`,
          type: step.type,
          status: step.status,
          stepKey: step.stepKey,
          contextPayload: step.contextPayload,
        }));
        const violations = checkRun(contracts, checkEvents);
        isViolation = violations.length > 0;

        await replayCacheCol
          .updateOne(
            { key: cacheKey },
            {
              $setOnInsert: {
                key: cacheKey,
                inputId: input.id,
                seed,
                agentVersion: 'v1',
                isViolation,
                createdAt: new Date(),
              },
            },
            { upsert: true },
          )
          .catch(() => undefined);
      }

      if (isViolation) violationsCount++;
    }
  }

  const replayWilson = wilsonScoreInterval(violationsCount, totalEvals);
  const baselineWilson = wilsonScoreInterval(0, totalEvals);
  const cellVerdict = determineVerdict(replayWilson, baselineWilson, config.EXPERIMENT_EPSILON);

  // 5. Build recall query from change summaries (only if changes exist)
  let recallRes = { results: [] as RecallResultItem[], mode: 'none' };
  if (changes.length > 0) {
    const changeSummaries = changes.map((c) => c.summary).join(' ');
    const recallQuery = changeSummaries || 'proposed configuration change';

    recallRes = await recallLessons(db, {
      projectId,
      query: recallQuery,
      minScore: config.LESSON_MIN_SCORE,
      limit: 3,
    });
  }

  // 6. Determine final verdict & reasons
  const reasons: string[] = [];
  let verdict: 'block' | 'warn' | 'pass' = 'pass';

  if (replayWilson.lower > config.EXPERIMENT_EPSILON) {
    verdict = 'block';
    reasons.push(
      `Replay simulation failed: ${(replayWilson.estimate * 100).toFixed(0)}% violation rate (Wilson 95% CI [${(
        replayWilson.lower * 100
      ).toFixed(0)}%, ${(replayWilson.upper * 100).toFixed(0)}%]).`,
    );
  }

  if (recallRes.results.length > 0) {
    const topLesson = recallRes.results[0]!;
    reasons.push(
      `Matched past incident lesson (${topLesson.lessonId}, score ${(topLesson.score * 100).toFixed(
        0,
      )}%): ${topLesson.lesson.symptom}`,
    );
    if (verdict === 'pass') {
      verdict = 'warn';
    }
  }

  if (cellVerdict === 'inconclusive' && verdict === 'pass') {
    verdict = 'warn';
    reasons.push('Replay simulation yielded inconclusive statistical bounds against baseline.');
  }

  if (verdict === 'pass') {
    reasons.push('All contracts satisfied with 0% violation rate across test corpus; no matching regression lessons found.');
  }

  // 7. Plain compact summary <= 600 chars for LLM narration
  const changeCount = changes.length;
  const violationPct = (replayWilson.estimate * 100).toFixed(0);
  const matchNotice =
    recallRes.results.length > 0
      ? ` Matches lesson ${recallRes.results[0]!.lessonId} (${recallRes.results[0]!.lesson.fix.slice(0, 100)}).`
      : ' No regression history.';

  let summary = `Preflight verdict ${verdict.toUpperCase()}: ${changeCount} change(s) proposed across [${units.join(
    ', ',
  )}]. Replay shows ${violationPct}% violation rate [${(replayWilson.lower * 100).toFixed(0)}%-${(
    replayWilson.upper * 100
  ).toFixed(0)}%].${matchNotice}`;

  if (summary.length > 600) {
    summary = summary.slice(0, 597) + '...';
  }

  return {
    projectId,
    verdict,
    reasons,
    summary,
    changes,
    units,
    replay: {
      evaluations: totalEvals,
      violationsCount,
      violationRate: replayWilson.estimate,
      wilson: replayWilson,
      verdict: cellVerdict,
    },
    matchedLessons: recallRes.results,
    recallMode: recallRes.mode,
    timestamp: new Date().toISOString(),
  };
}

