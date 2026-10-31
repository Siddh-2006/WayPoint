/**
 * server/src/contracts/mine.ts
 *
 * Mined tool contracts via MongoDB aggregation pipelines.
 * Learns required keys, argument types, and support statistics from known-good baseline runs.
 */

import { type Db } from 'mongodb';
import { config } from '../config.js';
import type { ContractDoc } from './check.js';

export interface MineResultNoBaseline {
  status: 'no_baseline_yet';
  have: number;
  need: number;
}

export interface MineResultSuccess {
  status: 'mined';
  baselineHash: string;
  contracts: ContractDoc[];
}

export type MineResult = MineResultNoBaseline | MineResultSuccess;

/**
 * Mine contracts for a given project and baseline contextHash using MongoDB aggregation.
 */
export async function mineContracts(
  db: Db,
  projectId: string,
  baselineHash: string,
): Promise<MineResult> {
  const runsCol = db.collection('runs');
  const eventsCol = db.collection('events');
  const contractsCol = db.collection<ContractDoc>('contracts');
  const deploymentsCol = db.collection('deployments');

  // 1. Find completed runs with zero violations for this contextHash
  const validRuns = await runsCol
    .find({
      projectId,
      contextHash: baselineHash,
      status: 'completed',
      $or: [{ violations: { $exists: false } }, { violations: { $size: 0 } }],
    })
    .toArray();

  const totalRuns = validRuns.length;
  if (totalRuns < config.MIN_BASELINE_RUNS) {
    return {
      status: 'no_baseline_yet',
      have: totalRuns,
      need: config.MIN_BASELINE_RUNS,
    };
  }

  const baselineRunIds = validRuns.map((r) => r['runId'] as string);

  // 2. Count total distinct runs per tool
  const toolRunsAgg = await eventsCol
    .aggregate<{ _id: string; totalToolRuns: number }>([
      {
        $match: {
          projectId,
          runId: { $in: baselineRunIds },
          type: 'tool_call',
          status: 'ok',
        },
      },
      {
        $project: {
          runId: 1,
          tool: {
            $ifNull: ['$contextPayload.tool', '$stepKey'],
          },
        },
      },
      {
        $group: {
          _id: '$tool',
          distinctRuns: { $addToSet: '$runId' },
        },
      },
      {
        $project: {
          _id: 1,
          totalToolRuns: { $size: '$distinctRuns' },
        },
      },
    ])
    .toArray();

  const toolTotals = new Map<string, number>();
  for (const t of toolRunsAgg) {
    toolTotals.set(t._id, t.totalToolRuns);
  }

  // 3. Aggregate distinct runs and observed types per (tool, key)
  const keyStatsAgg = await eventsCol
    .aggregate<{
      _id: { tool: string; key: string };
      runsWithKeyCount: number;
      observedTypes: string[];
    }>([
      {
        $match: {
          projectId,
          runId: { $in: baselineRunIds },
          type: 'tool_call',
          status: 'ok',
        },
      },
      {
        $project: {
          runId: 1,
          tool: {
            $ifNull: ['$contextPayload.tool', '$stepKey'],
          },
          argsArray: {
            $objectToArray: {
              $ifNull: ['$contextPayload.args', {}],
            },
          },
        },
      },
      { $unwind: '$argsArray' },
      {
        $group: {
          _id: {
            tool: '$tool',
            key: '$argsArray.k',
          },
          distinctRuns: { $addToSet: '$runId' },
          observedTypes: { $addToSet: { $type: '$argsArray.v' } },
        },
      },
      {
        $project: {
          _id: 1,
          runsWithKeyCount: { $size: '$distinctRuns' },
          observedTypes: 1,
        },
      },
    ])
    .toArray();

  // 4. Group results by tool and calculate support
  interface ToolAccumulator {
    requiredKeys: string[];
    types: Record<string, string[]>;
    support: Record<string, number>;
  }

  const toolsMap = new Map<string, ToolAccumulator>();

  for (const stat of keyStatsAgg) {
    const { tool, key } = stat._id;
    const totalForTool = toolTotals.get(tool) ?? totalRuns;
    const support = totalForTool > 0 ? stat.runsWithKeyCount / totalForTool : 0;

    let acc = toolsMap.get(tool);
    if (!acc) {
      acc = { requiredKeys: [], types: {}, support: {} };
      toolsMap.set(tool, acc);
    }

    acc.support[key] = Math.round(support * 1000) / 1000;
    acc.types[key] = stat.observedTypes;

    if (support >= config.CONTRACT_MIN_SUPPORT) {
      acc.requiredKeys.push(key);
    }
  }

  const minedContracts: ContractDoc[] = [];

  for (const [tool, acc] of toolsMap.entries()) {
    acc.requiredKeys.sort();
    const doc: ContractDoc = {
      projectId,
      tool,
      requiredKeys: acc.requiredKeys,
      types: acc.types,
      support: acc.support,
      minedFrom: {
        hash: baselineHash,
        runs: toolTotals.get(tool) ?? totalRuns,
      },
      minedAt: new Date(),
    };

    await contractsCol.updateOne(
      { projectId, tool },
      { $set: doc },
      { upsert: true },
    );

    minedContracts.push(doc);
  }

  // 5. Update deployments record with baselineHash
  await deploymentsCol.updateOne(
    { projectId },
    {
      $set: { baselineHash },
      $setOnInsert: { rev: 1, history: [] },
    },
    { upsert: true },
  );

  return {
    status: 'mined',
    baselineHash,
    contracts: minedContracts,
  };
}
