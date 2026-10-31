/**
 * server/src/detect/detector.ts
 *
 * Real-time Incident Detector powered by MongoDB Change Streams.
 *
 * Watches the `runs` collection.
 * - Persists resume token to `meta` after each event for fault-tolerant restart.
 * - Computes a sliding-window failure rate per (projectId, contextHash) over DETECT_WINDOW runs.
 * - Opens an incident when failure rate >= DETECT_THRESHOLD (with >= DETECT_MIN_RUNS).
 * - Enforces exactly one OPEN incident per (projectId, contextHash) via unique partial index.
 */

import type { ChangeStream, Db } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { config } from '../config.js';
import { diffContexts } from '../contexts/diff.js';
import type { ContextData } from '../contexts/hash.js';

let activeStream: ChangeStream | null = null;
let isRunning = false;

export interface IncidentDoc {
  projectId: string;
  baselineHash: string;
  badHash: string;
  changes: unknown[];
  evidenceRunIds: string[];
  violationSummary: Record<string, number>;
  rate: number;
  status: 'open' | 'resolved';
  openedAt: Date;
}

/**
 * Evaluates a single run document against detection thresholds and opens an incident if warranted.
 */
export async function evaluateRunForIncident(
  db: Db,
  projectId: string,
  contextHash: string,
): Promise<IncidentDoc | null> {
  const runsCol = db.collection('runs');
  const deploymentsCol = db.collection('deployments');
  const contextsCol = db.collection('contexts');
  const incidentsCol = db.collection('incidents');

  // 1. Fetch recent runs in sliding window
  const windowRuns = await runsCol
    .find({
      projectId,
      contextHash,
      status: { $in: ['completed', 'failed'] },
    })
    .sort({ startedAt: -1, _id: -1 })
    .limit(config.DETECT_WINDOW)
    .toArray();

  if (windowRuns.length < config.DETECT_MIN_RUNS) {
    return null;
  }

  // 2. Compute failure rate
  const failedRuns = windowRuns.filter(
    (r) =>
      (Array.isArray(r['violations']) && r['violations'].length > 0) ||
      r['status'] === 'failed',
  );

  const rate = failedRuns.length / windowRuns.length;
  if (rate < config.DETECT_THRESHOLD) {
    return null;
  }

  // 3. Check for established baseline
  const deployment = await deploymentsCol.findOne({ projectId });
  const baselineHash = deployment?.['baselineHash'] as string | undefined;

  if (!baselineHash || baselineHash === contextHash) {
    console.log(
      `[Detector] Violation rate ${rate.toFixed(2)} for ${contextHash}, but no baseline set. Skipping incident.`,
    );
    return null;
  }

  // 4. Summarise violations across failed runs
  const violationSummary: Record<string, number> = {};
  for (const fr of failedRuns) {
    const viols = (fr['violations'] as Array<{ rule?: string }>) ?? [];
    for (const v of viols) {
      const rule = v.rule ?? 'unknown';
      violationSummary[rule] = (violationSummary[rule] ?? 0) + 1;
    }
  }

  // 5. Diff baseline against bad context
  const [baseCtx, badCtx] = await Promise.all([
    contextsCol.findOne<ContextData>({ contentHash: baselineHash }),
    contextsCol.findOne<ContextData>({ contentHash: contextHash }),
  ]);

  const changes = baseCtx && badCtx ? diffContexts(baseCtx, badCtx) : [];

  const incidentDoc: IncidentDoc = {
    projectId,
    baselineHash,
    badHash: contextHash,
    changes,
    evidenceRunIds: failedRuns.map((r) => r['runId'] as string),
    violationSummary,
    rate: Math.round(rate * 100) / 100,
    status: 'open',
    openedAt: new Date(),
  };

  try {
    await incidentsCol.insertOne(incidentDoc as never);
    console.log(
      `[Detector] Opened incident for project "${projectId}" badHash="${contextHash.slice(0, 10)}..." (rate=${rate.toFixed(2)})`,
    );
    return incidentDoc;
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      // Unique index on { projectId: 1, badHash: 1, status: 'open' } prevented duplicate
      return null;
    }
    throw err;
  }
}

/**
 * Start the real-time detector change stream.
 */
export async function startDetector(db: Db): Promise<ChangeStream> {
  if (isRunning && activeStream) {
    return activeStream;
  }

  const metaCol = db.collection('meta');
  const runsCol = db.collection('runs');

  const resumeDoc = await metaCol.findOne<{ token?: unknown }>({ _id: 'runs_detector_resume' as never });
  const resumeToken = resumeDoc?.token;

  const options = resumeToken
    ? { resumeAfter: resumeToken as never, fullDocument: 'updateLookup' }
    : { fullDocument: 'updateLookup' };

  const stream = runsCol.watch([], options);
  activeStream = stream;
  isRunning = true;

  // Process stream asynchronously without blocking startup
  (async () => {
    try {
      for await (const change of stream) {
        if (!isRunning) break;

        // Persist resume token immediately
        if (change._id) {
          await metaCol
            .updateOne(
              { _id: 'runs_detector_resume' as never },
              { $set: { token: change._id, updatedAt: new Date() } },
              { upsert: true },
            )
            .catch(() => undefined);
        }

        const fullDoc = (change as { fullDocument?: Record<string, unknown> }).fullDocument;
        if (!fullDoc) continue;

        const projectId = fullDoc['projectId'] as string | undefined;
        const contextHash = fullDoc['contextHash'] as string | undefined;
        const status = fullDoc['status'] as string | undefined;

        if (projectId && contextHash && (status === 'completed' || status === 'failed')) {
          await evaluateRunForIncident(db, projectId, contextHash).catch((err) => {
            console.error('[Detector] Error evaluating run:', err);
          });
        }
      }
    } catch (err) {
      if (isRunning) {
        console.error('[Detector] Stream error:', err);
      }
    }
  })();

  return stream;
}

/**
 * Stop the detector (used in gate tests and graceful shutdown).
 */
export async function stopDetector(): Promise<void> {
  isRunning = false;
  if (activeStream) {
    await activeStream.close();
    activeStream = null;
  }
}
