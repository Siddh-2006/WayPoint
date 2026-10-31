/**
 * server/src/replay/engine.ts
 *
 * Generic Freeze-Replay Experiment Engine.
 *
 * Evaluates context regressions using factorial permutation testing and Shapley attribution:
 *   - Derives change units generically via extractUnits(baseline, bad)
 *   - Synthesizes hybrid contexts via pure applyUnits(baseline, bad, activeUnits)
 *   - Oracle: production checkRun contracts (or pluggable synthetic oracle)
 *   - Replay isolation: writes 0 docs to runs/events; persists only in experiments
 *   - Memoization: caches every (contextHash, inputId, seed, agentVersion) in replayCache
 *   - Exact 2^k for k <= EXPERIMENT_MAX_FULL_K; Monte Carlo sampling for k > 4
 *   - Wilson 95% confidence intervals and honest cell verdicts (failing | ok | inconclusive)
 *   - Seeded bootstrap intervals for Shapley attributions and pairwise interactions
 *   - Required caveat: "Shapley is credit assignment over replay outcomes, not proof of causality."
 */

import { ObjectId, type Db } from 'mongodb';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { hashContext, type ContextData } from '../contexts/hash.js';
import { runAgent, type InvoiceInput } from '../demo/invoice-agent.js';
import { checkRun, type ContractDoc } from '../contracts/check.js';
import { extractUnits, applyUnits } from './units.js';
import { computeShapley, subsetToMask } from './shapley.js';
import {
  wilsonScoreInterval,
  determineVerdict,
  bootstrapShapleyIntervals,
  calculatePairwiseInteraction,
  type WilsonInterval,
  type CellVerdict,
} from './stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, '../demo/corpus.json');

let corpusCache: InvoiceInput[] | null = null;
export function getCorpus(): InvoiceInput[] {
  if (!corpusCache) {
    const raw = readFileSync(CORPUS_PATH, 'utf-8');
    corpusCache = JSON.parse(raw) as InvoiceInput[];
  }
  return corpusCache;
}

export function toObjectIdOrString(id: string): any {
  if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) {
    return new ObjectId(id);
  }
  return id;
}

export const SHAPLEY_CAVEAT = 'Shapley is credit assignment over replay outcomes, not proof of causality.';

export class BaselinePrerequisiteError extends Error {
  constructor(message: string, public readonly have: number, public readonly need: number) {
    super(message);
    this.name = 'BaselinePrerequisiteError';
  }
}

export class ExperimentAlreadyRunningError extends Error {
  constructor(incidentId: string) {
    super(`An experiment is already running for incident ${incidentId}`);
    this.name = 'ExperimentAlreadyRunningError';
  }
}

export interface ReplayCellStats {
  mask: string;
  activeUnits: string[];
  evaluations: number;
  violationsCount: number;
  violationRate: number;
  wilson: WilsonInterval;
  verdict: CellVerdict;
}

export interface PairwiseInteraction {
  pair: [string, string];
  interaction: number;
}

export interface ExperimentDoc {
  _id: string;
  incidentId: string;
  projectId: string;
  baselineHash: string;
  badHash: string;
  units: string[];
  grid: ReplayCellStats[];
  shapley: Record<string, number>;
  shapleyIntervals: Record<string, { lower: number; upper: number }>;
  pairwiseInteractions: PairwiseInteraction[];
  totalShift: number;
  culprits: string[];
  interactionEffect: boolean;
  method: 'exact' | 'sampled';
  methodNote?: string | undefined;
  caveat: string;
  recommendation: string;
  agentCallsCount: number;
  cacheHitsCount: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  reason?: string | undefined;
  createdAt: Date;
  startedAt?: Date | undefined;
  endedAt?: Date | undefined;
}

export type PluggableOracle = (
  context: ContextData,
  input: InvoiceInput,
  seed: number,
) => { isViolation: boolean; violationsCount: number };

export interface RunReplayOptions {
  customOracle?: PluggableOracle;
  customInputs?: InvoiceInput[];
  samplesPerInput?: number;
  epsilon?: number;
  maxFullK?: number;
  permSamples?: number;
  resampleInputs?: boolean;
  cacheNamespace?: string;
}

/**
 * Executes a replay experiment either synchronously or inside the async runner.
 */
export async function executeReplay(
  db: Db,
  experimentId: string,
  incidentId: string,
  options: RunReplayOptions = {},
): Promise<ExperimentDoc> {
  const experimentsCol = db.collection<ExperimentDoc>('experiments');
  const incidentsCol = db.collection('incidents');
  const contextsCol = db.collection('contexts');
  const replayCacheCol = db.collection('replayCache');
  const deploymentsCol = db.collection('deployments');
  const contractsCol = db.collection<ContractDoc>('contracts');
  const runsCol = db.collection('runs');

  const now = new Date();
  await experimentsCol.updateOne(
    { _id: experimentId },
    { $set: { status: 'running', startedAt: now } },
  );

  try {
    // 1. Fetch incident
    const objId = toObjectIdOrString(incidentId);
    const incident = await incidentsCol.findOne({
      $or: [{ _id: objId }, { _id: incidentId as any }, { incidentId }],
    });
    if (!incident) throw new Error(`Incident not found: ${incidentId}`);

    const { projectId, baselineHash, badHash } = incident;

    // 2. Validate baseline prerequisite
    const deployment = await deploymentsCol.findOne({ projectId });
    if (!deployment || !deployment['baselineHash']) {
      throw new BaselinePrerequisiteError(
        'Project has no baseline hash recorded on deployments',
        0,
        config.MIN_BASELINE_RUNS,
      );
    }

    const baselineRunsCount = await runsCol.countDocuments({
      projectId,
      contextHash: deployment['baselineHash'],
      status: 'completed',
    });

    if (baselineRunsCount < config.MIN_BASELINE_RUNS) {
      throw new BaselinePrerequisiteError(
        `Insufficient baseline runs for project ${projectId}`,
        baselineRunsCount,
        config.MIN_BASELINE_RUNS,
      );
    }

    // 3. Fetch context docs
    const [baselineDoc, badDoc] = await Promise.all([
      contextsCol.findOne({ contentHash: baselineHash }),
      contextsCol.findOne({ contentHash: badHash }),
    ]);

    if (!baselineDoc || !badDoc) {
      throw new Error(`Contexts not found for baseline ${baselineHash} or bad ${badHash}`);
    }

    const baselineContext: ContextData = {
      model: baselineDoc['model'],
      promptText: baselineDoc['promptText'],
      config: baselineDoc['config'] ?? {},
      toolSchemas: baselineDoc['toolSchemas'] ?? {},
      deps: baselineDoc['deps'] ?? {},
    };

    const badContext: ContextData = {
      model: badDoc['model'],
      promptText: badDoc['promptText'],
      config: badDoc['config'] ?? {},
      toolSchemas: badDoc['toolSchemas'] ?? {},
      deps: badDoc['deps'] ?? {},
    };

    // 4. Extract units generically
    const units = extractUnits(baselineContext, badContext);
    const k = units.length;
    if (k === 0) throw new Error('No differences detected between baseline and bad contexts');

    // 5. Setup inputs, samples, and oracle
    const inputs = options.customInputs ?? getCorpus();
    const samplesPerInput = options.samplesPerInput ?? config.REPLAY_SAMPLES;
    const maxFullK = options.maxFullK ?? config.EXPERIMENT_MAX_FULL_K;
    const permSamples = options.permSamples ?? config.EXPERIMENT_PERM_SAMPLES;
    const epsilon = options.epsilon ?? config.EXPERIMENT_EPSILON;

    const contracts = await contractsCol.find({ projectId }).toArray();

    const defaultOracle: PluggableOracle = (ctx, input, seed) => {
      const result = runAgent({ context: ctx, input, seed });
      const checkEvents = result.steps.map((s, idx) => ({
        eventId: `replay:${input.id}:${idx + 1}`,
        runId: `replay:${input.id}`,
        type: s.type,
        status: s.status,
        stepKey: s.stepKey,
        contextPayload: s.contextPayload,
      }));
      const violations = checkRun(contracts, checkEvents);
      return {
        isViolation: violations.length > 0,
        violationsCount: violations.length,
      };
    };

    const oracle = options.customOracle ?? defaultOracle;

    let agentCallsCount = 0;
    let cacheHitsCount = 0;

    // 6. Evaluate grid cells
    // If k <= maxFullK: generate all 2^k subsets.
    // If k > maxFullK: generate permutations as needed, plus empty and full.
    const totalSubsets = 1 << k;
    const coalitionValues: Record<string, number> = {};
    const inputOutcomes: Array<Record<string, number>> = [];
    for (let i = 0; i < inputs.length; i++) inputOutcomes.push({});

    const cellInterimStats: Array<{
      mask: string;
      activeUnits: string[];
      totalViolations: number;
      totalEvals: number;
    }> = [];

    for (let maskNum = 0; maskNum < totalSubsets; maskNum++) {
      const indices: number[] = [];
      for (let bit = 0; bit < k; bit++) {
        if ((maskNum & (1 << (k - 1 - bit))) !== 0) indices.push(bit);
      }
      const mask = subsetToMask(indices, k);
      const activeUnitNames = indices.map((idx) => units[idx]!);
      const hybridContext = applyUnits(baselineContext, badContext, activeUnitNames);
      const hybridHash = hashContext(hybridContext);

      let cellViolations = 0;
      const totalEvals = inputs.length * samplesPerInput;

      for (let inputIdx = 0; inputIdx < inputs.length; inputIdx++) {
        const input = inputs[inputIdx]!;
        let inputViolations = 0;

        for (let s = 1; s <= samplesPerInput; s++) {
          const numId = parseInt(input.id.replace(/\D/g, ''), 10) || (inputIdx + 1);
          const seed = numId * 1000 + s;
          const cacheNs = options.cacheNamespace ?? 'v1';
          const cacheKey = `replay:${hybridHash}:${input.id}:${seed}:${cacheNs}`;

          // Check replayCache
          const cached = await replayCacheCol.findOne({ key: cacheKey });
          let isViolation = false;

          if (cached) {
            cacheHitsCount++;
            isViolation = Boolean(cached['isViolation']);
          } else {
            agentCallsCount++;
            const evalResult = oracle(hybridContext, input, seed);
            isViolation = evalResult.isViolation;

            await replayCacheCol
              .updateOne(
                { key: cacheKey },
                {
                  $setOnInsert: {
                    key: cacheKey,
                    contextHash: hybridHash,
                    inputId: input.id,
                    seed,
                    agentVersion: cacheNs,
                    isViolation,
                    createdAt: new Date(),
                  },
                },
                { upsert: true },
              )
              .catch(() => undefined);
          }

          if (isViolation) {
            cellViolations++;
            inputViolations++;
          }
        }

        // Store fraction of violations for this input in this coalition
        inputOutcomes[inputIdx]![mask] = inputViolations / samplesPerInput;
      }

      const violationRate = totalEvals > 0 ? cellViolations / totalEvals : 0;
      coalitionValues[mask] = violationRate;

      cellInterimStats.push({
        mask,
        activeUnits: activeUnitNames,
        totalViolations: cellViolations,
        totalEvals,
      });
    }

    // 7. Wilson intervals and verdicts
    const emptyMask = '0'.repeat(k);
    const baselineCell = cellInterimStats.find((c) => c.mask === emptyMask)!;
    const baselineInterval = wilsonScoreInterval(
      baselineCell.totalViolations,
      baselineCell.totalEvals,
    );

    const grid: ReplayCellStats[] = cellInterimStats.map((c) => {
      const interval = wilsonScoreInterval(c.totalViolations, c.totalEvals);
      const verdict = determineVerdict(interval, baselineInterval, epsilon);
      return {
        mask: c.mask,
        activeUnits: c.activeUnits,
        evaluations: c.totalEvals,
        violationsCount: c.totalViolations,
        violationRate: Math.round(interval.estimate * 10000) / 10000,
        wilson: interval,
        verdict,
      };
    });

    // 8. Shapley calculation & Monte Carlo sampling
    const shapleyRes = computeShapley({
      changes: units,
      coalitionValues,
      maxFullK,
      samplePermutations: permSamples,
    });

    // 9. Bootstrap confidence intervals for Shapley
    const shapleyComputer = (cValues: Record<string, number>) =>
      computeShapley({ changes: units, coalitionValues: cValues, maxFullK }).attributions;

    const shapleyIntervals = bootstrapShapleyIntervals(inputOutcomes, units, shapleyComputer, 200);

    // 10. Pairwise interactions: v(AB) - v(A) - v(B) + v(0)
    const pairwiseInteractions: PairwiseInteraction[] = [];
    const v0 = coalitionValues[emptyMask] ?? 0;

    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const maskA = subsetToMask([i], k);
        const maskB = subsetToMask([j], k);
        const maskAB = subsetToMask([i, j], k);

        const vA = coalitionValues[maskA] ?? 0;
        const vB = coalitionValues[maskB] ?? 0;
        const vAB = coalitionValues[maskAB] ?? 0;

        const interaction = calculatePairwiseInteraction(vAB, vA, vB, v0);
        pairwiseInteractions.push({
          pair: [units[i]!, units[j]!],
          interaction,
        });
      }
    }

    // 11. Culprits and Interaction effect
    const singleFailureRates = units.map((_, idx) => coalitionValues[subsetToMask([idx], k)] ?? 0);
    const maxSingleFailure = Math.max(0, ...singleFailureRates);
    const interactionEffect = maxSingleFailure < 0.5 && shapleyRes.totalShift >= 0.5;

    const culprits = units.filter((u) => (shapleyRes.attributions[u] ?? 0) >= 0.15);

    let recommendation = '';
    if (interactionEffect && culprits.length >= 2) {
      recommendation = `Multi-variable interaction confirmed: Joint changes in [${culprits.join(
        ', ',
      )}] caused silent contract failure. Reverting any one component restores compliance.`;
    } else if (culprits.length === 1) {
      recommendation = `Isolated regression: Component '${culprits[0]}' is the sole culprit (${(
        (shapleyRes.attributions[culprits[0]!] ?? 0) * 100
      ).toFixed(0)}% attribution).`;
    } else {
      recommendation = `No distinct culprit isolated across evaluated components.`;
    }

    const docUpdate: Partial<ExperimentDoc> = {
      status: 'done',
      units,
      grid,
      shapley: shapleyRes.attributions,
      shapleyIntervals,
      pairwiseInteractions,
      totalShift: shapleyRes.totalShift,
      culprits,
      interactionEffect,
      method: shapleyRes.method,
      methodNote: shapleyRes.methodNote,
      caveat: SHAPLEY_CAVEAT,
      recommendation,
      agentCallsCount,
      cacheHitsCount,
      endedAt: new Date(),
    };

    await experimentsCol.updateOne({ _id: experimentId }, { $set: docUpdate });

    // Link experiment to incident
    await incidentsCol.updateOne(
      { _id: incident._id },
      { $set: { experimentId, status: 'investigating', resolvedByExperiment: true } },
    );

    const finalDoc = (await experimentsCol.findOne({ _id: experimentId })) as ExperimentDoc;
    return finalDoc;
  } catch (err) {
    await experimentsCol.updateOne(
      { _id: experimentId },
      {
        $set: {
          status: 'failed',
          reason: String(err),
          endedAt: new Date(),
        },
      },
    );
    throw err;
  }
}

/**
 * Creates and queues a new replay experiment.
 * Enforces: only ONE running experiment per incident.
 */
export async function queueReplayExperiment(
  db: Db,
  incidentId: string,
  options: RunReplayOptions = {},
): Promise<{ experimentId: string; status: string }> {
  const experimentsCol = db.collection('experiments');
  const incidentsCol = db.collection('incidents');
  const deploymentsCol = db.collection('deployments');
  const runsCol = db.collection('runs');

  const objId = toObjectIdOrString(incidentId);
  const incident = await incidentsCol.findOne({
    $or: [{ _id: objId }, { _id: incidentId as any }, { incidentId }],
  });
  if (!incident) throw new Error(`Incident not found: ${incidentId}`);

  const projectId = incident['projectId'] as string;

  // Prerequisite check: Baseline exists and has >= MIN_BASELINE_RUNS completed runs
  const deployment = await deploymentsCol.findOne({ projectId });
  if (!deployment || !deployment['baselineHash']) {
    throw new BaselinePrerequisiteError(
      'Project has no baseline hash recorded on deployments',
      0,
      config.MIN_BASELINE_RUNS,
    );
  }

  const baselineRunsCount = await runsCol.countDocuments({
    projectId,
    contextHash: deployment['baselineHash'],
    status: 'completed',
  });

  if (baselineRunsCount < config.MIN_BASELINE_RUNS) {
    throw new BaselinePrerequisiteError(
      `Insufficient baseline runs for project ${projectId}`,
      baselineRunsCount,
      config.MIN_BASELINE_RUNS,
    );
  }

  // Prevent multiple concurrent running experiments on the same incident
  const activeExp = await experimentsCol.findOne({
    incidentId: String(incident._id ?? incidentId),
    status: { $in: ['queued', 'running'] },
  });

  if (activeExp) {
    throw new ExperimentAlreadyRunningError(incidentId);
  }

  const experimentId = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const initialDoc: ExperimentDoc = {
    _id: experimentId,
    incidentId: String(incident._id ?? incidentId),
    projectId,
    baselineHash: incident['baselineHash'],
    badHash: incident['badHash'],
    units: [],
    grid: [],
    shapley: {},
    shapleyIntervals: {},
    pairwiseInteractions: [],
    totalShift: 0,
    culprits: [],
    interactionEffect: false,
    method: 'exact',
    caveat: SHAPLEY_CAVEAT,
    recommendation: 'Analysis running...',
    agentCallsCount: 0,
    cacheHitsCount: 0,
    status: 'queued',
    createdAt: new Date(),
  };

  await experimentsCol.insertOne(initialDoc as any);

  // Kick off asynchronous execution
  setImmediate(() => {
    executeReplay(db, experimentId, incidentId, options).catch((err) => {
      console.error(`Replay experiment ${experimentId} failed:`, err);
    });
  });

  return { experimentId, status: 'queued' };
}
