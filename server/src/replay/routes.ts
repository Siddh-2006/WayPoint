/**
 * server/src/replay/routes.ts
 *
 * Fastify routes for Freeze-Replay experiments and Shapley attribution:
 *   - POST /v1/incidents/:id/replay — triggers async experiment (202 Accepted)
 *   - GET  /v1/experiments/:id      — retrieves experiment status & full grid
 *   - GET  /v1/experiments          — lists experiments for a project
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import {
  queueReplayExperiment,
  executeReplay,
  toObjectIdOrString,
  BaselinePrerequisiteError,
  ExperimentAlreadyRunningError,
} from './engine.js';

function isAuthorized(apiKeyHeader: string | undefined): boolean {
  if (!apiKeyHeader) return false;
  return config.API_KEYS.includes(apiKeyHeader);
}

function isPublicProject(projectId: string): boolean {
  return config.READ_PUBLIC_PROJECTS.includes(projectId);
}

export async function replayRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const experimentsCol = db.collection('experiments');
  const incidentsCol = db.collection('incidents');

  // POST /v1/incidents/:id/replay
  app.post<{
    Params: { id: string };
    Querystring: { sync?: string };
  }>('/v1/incidents/:id/replay', async (req, reply) => {
    const { id: incidentId } = req.params;
    const isSync = req.query.sync === 'true';

    // Verify incident exists
    const objId = toObjectIdOrString(incidentId);
    const incident = await incidentsCol.findOne({
      $or: [{ _id: objId }, { _id: incidentId as any }, { incidentId }],
    });

    if (!incident) {
      return reply.code(404).send({ error: 'Incident not found' });
    }

    const projectId = incident['projectId'] as string;
    const apiKey = req.headers['x-api-key'] as string | undefined;

    // Public projects (demo) allow guest trigger; private projects require key
    if (!isPublicProject(projectId) && !isAuthorized(apiKey)) {
      return reply.code(401).send({ error: 'Unauthorized: valid x-api-key required' });
    }

    try {
      if (isSync) {
        // Synchronous execution (useful for deterministic gate scripts)
        const experimentId = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await experimentsCol.insertOne({
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
          caveat: '',
          recommendation: '',
          agentCallsCount: 0,
          cacheHitsCount: 0,
          status: 'running',
          createdAt: new Date(),
        } as any);

        const experiment = await executeReplay(db, experimentId, incidentId);
        return reply.code(200).send({ ok: true, experimentId: experiment._id, experiment });
      }

      // Default: Async run (202 Accepted)
      const queued = await queueReplayExperiment(db, incidentId);
      return reply.code(202).send({
        ok: true,
        experimentId: queued.experimentId,
        status: queued.status,
      });
    } catch (err) {
      if (err instanceof BaselinePrerequisiteError) {
        return reply.code(409).send({
          error: 'Baseline prerequisite not met',
          message: err.message,
          have: err.have,
          need: err.need,
        });
      }
      if (err instanceof ExperimentAlreadyRunningError) {
        return reply.code(409).send({
          error: 'Experiment already running',
          message: err.message,
        });
      }

      req.log.error(err, 'Failed to queue replay experiment');
      return reply.code(500).send({ error: 'Replay experiment failed', message: String(err) });
    }
  });

  // GET /v1/experiments/:id
  app.get<{ Params: { id: string } }>('/v1/experiments/:id', async (req, reply) => {
    const { id } = req.params;
    const exp = await experimentsCol.findOne({
      $or: [{ _id: id as any }, { incidentId: id }],
    });

    if (!exp) {
      return reply.code(404).send({ error: 'Experiment not found' });
    }

    const projectId = exp['projectId'] as string;
    const apiKey = req.headers['x-api-key'] as string | undefined;

    if (!isPublicProject(projectId) && !isAuthorized(apiKey)) {
      return reply.code(403).send({ error: 'Forbidden: project requires x-api-key' });
    }

    return reply.send({ experiment: exp });
  });

  // GET /v1/experiments?projectId=...
  app.get<{ Querystring: { projectId?: string } }>('/v1/experiments', async (req, reply) => {
    const { projectId } = req.query;

    if (!projectId) {
      return reply.code(400).send({ error: 'Missing projectId query parameter' });
    }

    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!isPublicProject(projectId) && !isAuthorized(apiKey)) {
      return reply.code(403).send({ error: 'Forbidden: project requires x-api-key' });
    }

    const experiments = await experimentsCol
      .find({ projectId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    return reply.send({ experiments });
  });
}
