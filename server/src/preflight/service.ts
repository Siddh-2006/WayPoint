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
import { getCorpus } from '../replay/engine.js';
import { runAgent } from '../demo/invoice-agent.js';
import { checkRun, type ContractDoc, type RunViolation } from '../contracts/check.js';
import { wilsonScoreInterval, determineVerdict, type WilsonInterval } from '../replay/stats.js';
import { recallLessons, type RecallResultItem } from '../lessons/recall.js';
import { BaselinePrerequisiteError } from '../replay/engine.js';
import type { ViolatedRuleRef } from '../lessons/service.js';

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
  const seenViolations: RunViolation[] = [];

  for (let idx = 0; idx < corpus.length; idx++) {
    const input = corpus[idx]!;
    for (let s = 1; s <= samples; s++) {
      const numId = parseInt(input.id.replace(/\D/g, ''), 10) || (idx + 1);
      const seed = numId * 1000 + s;
      const cacheKey = `replay:preflight:${projectId}:${proposedHash}:${input.id}:${seed}:v1`;

      let isViolation = false;
      const cached = await replayCacheCol.findOne({ key: cacheKey });
      if (cached) {
        isViolation = Boolean(cached['isViolation']);
        // Recover cached violations for recall query building
        if (isViolation && cached['violations']) {
          const cachedViols = cached['violations'] as RunViolation[];
          for (const v of cachedViols) {
            if (!seenViolations.some((sv) => sv.rule === v.rule && sv.expectedKey === v.expectedKey)) {
              seenViolations.push(v);
            }
          }
        }
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

        // Accumulate unique violations for recall query building
        for (const v of violations) {
          if (!seenViolations.some((sv) => sv.rule === v.rule && sv.expectedKey === v.expectedKey)) {
            seenViolations.push(v);
          }
        }

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
                violations: violations.length > 0 ? violations : [],
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

  // 5. Build recall query from violation messages (like-for-like with lesson.symptom)
  //    When replay produces violations, use the violation messages as the recall query —
  //    these are the same style as the symptom stored in a lesson.
  //    When replay is clean, fall back to change summaries (current behaviour).
  let recallRes = { results: [] as RecallResultItem[], mode: 'none' };
  if (changes.length > 0) {
    let recallQuery: string;
    if (seenViolations.length > 0) {
      // Build query from violation messages — same vocabulary as lesson.symptom
      const violationMsgs = seenViolations
        .slice(0, 3)
        .map((v) => v.message)
        .join('; ');
      const changeSummaries = changes.map((c) => c.summary).join(' ');
      recallQuery = `${violationMsgs}. ${changeSummaries}`;
    } else {
      const changeSummaries = changes.map((c) => c.summary).join(' ');
      recallQuery = changeSummaries || 'proposed configuration change';
    }

    recallRes = await recallLessons(db, {
      projectId,
      query: recallQuery,
      minScore: config.LESSON_MIN_SCORE,
      limit: 3,
    });
  }

  // 5b. Structural match: deterministic signal, no threshold.
  //     A lesson matches structurally when ALL of:
  //       1. lesson.violatedRules contains an entry (rule, expectedKey) that also appears in seenViolations
  //       2. the proposal's changed axes (units) overlap the lesson's culprit.units
  //     If a structural match fires, upgrade the tier to 'strong match' and attach reason.
  const proposalAxes = new Set(units);
  for (const item of recallRes.results) {
    const lesson = item.lesson;
    const lessonViolatedRules: ViolatedRuleRef[] = (lesson as any).violatedRules ?? [];
    const lessonCulpritUnits: string[] = lesson.culprit?.units ?? [];

    // Check rule+key overlap
    const ruleMatch = lessonViolatedRules.some((lr) =>
      seenViolations.some((sv) => sv.rule === lr.rule && sv.expectedKey === lr.expectedKey),
    );
    // Check axes overlap
    const axesOverlap = lessonCulpritUnits.some((u) => proposalAxes.has(u));

    if (ruleMatch && axesOverlap) {
      const matchedRule = lessonViolatedRules.find((lr) =>
        seenViolations.some((sv) => sv.rule === lr.rule && sv.expectedKey === lr.expectedKey),
      )!;
      const structReason = `same rule (${matchedRule.rule}) on key "${matchedRule.expectedKey}" and axes [${lessonCulpritUnits.join(', ')}]`;
      item.tier = 'strong match';
      item.structuralReason = structReason;
      item.why = `${item.why}; structural: ${structReason}`;
    }
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
    // A lesson is a strong match if:
    //   - cosine >= LESSON_MIN_SCORE (calibrated threshold), OR
    //   - structural match fired (same rule+key+axes — deterministic, no threshold)
    const hasStructural = Boolean(topLesson.structuralReason);
    const hasStrongCosine = topLesson.score >= config.LESSON_MIN_SCORE;
    const isStrongMatch = topLesson.tier === 'strong match' && (hasStrongCosine || hasStructural);

    if (isStrongMatch) {
      const structNote = hasStructural ? ` Structural: ${topLesson.structuralReason}.` : '';
      reasons.push(
        `Matched past incident lesson (${topLesson.lessonId}, score ${topLesson.score.toFixed(
          3,
        )} [${topLesson.tier}]):${structNote} ${topLesson.lesson.symptom}`,
      );
      if (verdict === 'pass') {
        verdict = 'warn';
      }
    } else {
      reasons.push(
        `Historical lesson noted (${topLesson.lessonId}, score ${topLesson.score.toFixed(
          3,
        )} [${topLesson.tier}]); below confidence threshold, verdict unchanged.`,
      );
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
    recallRes.results.length > 0 && recallRes.results[0]!.tier === 'strong match'
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

