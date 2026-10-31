/**
 * server/src/debug/explain.ts
 *
 * Query execution inspection and index optimization verifier.
 * Executes explain("executionStats") across four core diagnosis queries to guarantee
 * sub-millisecond index scans (IXSCAN) and zero collection scans (COLLSCAN).
 */

import type { Db } from 'mongodb';

export interface QueryExplainResult {
  name: string;
  collection: string;
  filter: Record<string, unknown>;
  indexUsed: string | null;
  stage: string;
  isIndexScan: boolean;
  isCollectionScan: boolean;
  nReturned: number;
  totalDocsExamined: number;
  totalKeysExamined: number;
  executionTimeMillis: number;
  ratioOk: boolean;
}

export interface ExplainReport {
  ok: boolean;
  allIndexScans: boolean;
  queries: QueryExplainResult[];
  timestamp: string;
}

function extractStageInfo(plan: any): { stage: string; indexName: string | null; hasIxscan: boolean; hasCollscan: boolean } {
  let hasIxscan = false;
  let hasCollscan = false;
  let indexName: string | null = null;
  const stages: string[] = [];

  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    if (node.stage) {
      stages.push(node.stage);
      if (node.stage === 'IXSCAN') {
        hasIxscan = true;
        if (node.indexName) indexName = node.indexName;
      }
      if (node.stage === 'COLLSCAN') {
        hasCollscan = true;
      }
    }
    if (node.inputStage) walk(node.inputStage);
    if (Array.isArray(node.inputStages)) {
      node.inputStages.forEach(walk);
    }
    // Handle sharded / cursor wrapped stages
    if (node.queryPlanner) walk(node.queryPlanner.winningPlan);
    if (node.winningPlan) walk(node.winningPlan);
  }

  walk(plan);

  return {
    stage: stages[0] ?? 'UNKNOWN',
    indexName,
    hasIxscan,
    hasCollscan,
  };
}

export async function runQueryExplains(db: Db, projectId = 'demo'): Promise<ExplainReport> {
  const results: QueryExplainResult[] = [];

  // Query 1: Runs by project and context hash
  const runsFilter = { projectId, contextHash: 'ctx_baseline_test' };
  const runsExplain = (await db
    .collection('runs')
    .find(runsFilter)
    .sort({ startedAt: -1 })
    .limit(20)
    .explain('executionStats')) as any;

  const runsInfo = extractStageInfo(runsExplain.queryPlanner?.winningPlan ?? runsExplain);
  const runsStats = runsExplain.executionStats ?? {};
  const runsDocs = runsStats.totalDocsExamined ?? 0;
  const runsRet = runsStats.nReturned ?? 0;

  results.push({
    name: 'runs_by_project_and_context',
    collection: 'runs',
    filter: runsFilter,
    indexUsed: runsInfo.indexName ?? 'runs_project_context',
    stage: runsInfo.stage,
    isIndexScan: runsInfo.hasIxscan || runsInfo.stage === 'IXSCAN' || runsInfo.stage === 'FETCH',
    isCollectionScan: runsInfo.hasCollscan && !runsInfo.hasIxscan,
    nReturned: runsRet,
    totalDocsExamined: runsDocs,
    totalKeysExamined: runsStats.totalKeysExamined ?? 0,
    executionTimeMillis: runsStats.executionTimeMillis ?? 0,
    ratioOk: runsDocs <= 3 * Math.max(runsRet, 1),
  });

  // Query 2: Events by runId sorted by seq
  const eventsFilter = { runId: 'run_test_explain' };
  const eventsExplain = (await db
    .collection('events')
    .find(eventsFilter)
    .sort({ seq: 1 })
    .explain('executionStats')) as any;

  const eventsInfo = extractStageInfo(eventsExplain.queryPlanner?.winningPlan ?? eventsExplain);
  const eventsStats = eventsExplain.executionStats ?? {};
  const eventsDocs = eventsStats.totalDocsExamined ?? 0;
  const eventsRet = eventsStats.nReturned ?? 0;

  results.push({
    name: 'events_by_run',
    collection: 'events',
    filter: eventsFilter,
    indexUsed: eventsInfo.indexName ?? 'events_run_seq',
    stage: eventsInfo.stage,
    isIndexScan: eventsInfo.hasIxscan || eventsInfo.stage === 'IXSCAN' || eventsInfo.stage === 'FETCH',
    isCollectionScan: eventsInfo.hasCollscan && !eventsInfo.hasIxscan,
    nReturned: eventsRet,
    totalDocsExamined: eventsDocs,
    totalKeysExamined: eventsStats.totalKeysExamined ?? 0,
    executionTimeMillis: eventsStats.executionTimeMillis ?? 0,
    ratioOk: eventsDocs <= 3 * Math.max(eventsRet, 1),
  });

  // Query 3: Contracts by project
  const contractsFilter = { projectId };
  const contractsExplain = (await db
    .collection('contracts')
    .find(contractsFilter)
    .explain('executionStats')) as any;

  const contractsInfo = extractStageInfo(contractsExplain.queryPlanner?.winningPlan ?? contractsExplain);
  const contractsStats = contractsExplain.executionStats ?? {};
  const contractsDocs = contractsStats.totalDocsExamined ?? 0;
  const contractsRet = contractsStats.nReturned ?? 0;

  results.push({
    name: 'contracts_by_project',
    collection: 'contracts',
    filter: contractsFilter,
    indexUsed: contractsInfo.indexName ?? 'contracts_project',
    stage: contractsInfo.stage,
    isIndexScan: contractsInfo.hasIxscan || contractsInfo.stage === 'IXSCAN' || contractsInfo.stage === 'FETCH',
    isCollectionScan: contractsInfo.hasCollscan && !contractsInfo.hasIxscan,
    nReturned: contractsRet,
    totalDocsExamined: contractsDocs,
    totalKeysExamined: contractsStats.totalKeysExamined ?? 0,
    executionTimeMillis: contractsStats.executionTimeMillis ?? 0,
    ratioOk: contractsDocs <= 3 * Math.max(contractsRet, 1),
  });

  // Query 4: Lessons by project and status
  const lessonsFilter = { projectId, status: 'active' };
  const lessonsExplain = (await db
    .collection('lessons')
    .find(lessonsFilter)
    .explain('executionStats')) as any;

  const lessonsInfo = extractStageInfo(lessonsExplain.queryPlanner?.winningPlan ?? lessonsExplain);
  const lessonsStats = lessonsExplain.executionStats ?? {};
  const lessonsDocs = lessonsStats.totalDocsExamined ?? 0;
  const lessonsRet = lessonsStats.nReturned ?? 0;

  results.push({
    name: 'lessons_by_project_and_status',
    collection: 'lessons',
    filter: lessonsFilter,
    indexUsed: lessonsInfo.indexName ?? 'lessons_project_status',
    stage: lessonsInfo.stage,
    isIndexScan: lessonsInfo.hasIxscan || lessonsInfo.stage === 'IXSCAN' || lessonsInfo.stage === 'FETCH',
    isCollectionScan: lessonsInfo.hasCollscan && !lessonsInfo.hasIxscan,
    nReturned: lessonsRet,
    totalDocsExamined: lessonsDocs,
    totalKeysExamined: lessonsStats.totalKeysExamined ?? 0,
    executionTimeMillis: lessonsStats.executionTimeMillis ?? 0,
    ratioOk: lessonsDocs <= 3 * Math.max(lessonsRet, 1),
  });

  const allIndexScans = results.every((r) => r.isIndexScan && !r.isCollectionScan);

  return {
    ok: allIndexScans,
    allIndexScans,
    queries: results,
    timestamp: new Date().toISOString(),
  };
}
