/**
 * server/src/detect/routes.ts
 *
 * Fastify routes for Incident Management:
 *   GET /v1/incidents      — list incidents (supports ?projectId= and ?status=)
 *   GET /v1/incidents/:id  — get incident detail with evidence runs and context changes
 */

import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { startDetector, stopDetector } from './detector.js';

import { isPublicDemoProject } from '../demo/sandbox.js';

export async function incidentRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const incidentsCol = db.collection('incidents');

  // POST /v1/detector/stop (for testing resume token recovery)
  app.post('/v1/detector/stop', async (_req, reply) => {
    await stopDetector();
    return reply.send({ ok: true, status: 'stopped' });
  });

  // POST /v1/detector/start (for testing resume token recovery)
  app.post('/v1/detector/start', async (_req, reply) => {
    await startDetector(db);
    return reply.send({ ok: true, status: 'started' });
  });

  // GET /v1/incidents
  app.get<{ Querystring: { projectId?: string; status?: string } }>(
    '/v1/incidents',
    async (req, reply) => {
      const projectId = req.query.projectId ?? 'demo';
      const isPublic = isPublicDemoProject(projectId);
      const key = req.headers['x-api-key'];
      const hasValidKey = typeof key === 'string' && config.API_KEYS.includes(key);

      if (!isPublic && !hasValidKey) {
        return reply.code(403).send({ error: 'Forbidden: project requires x-api-key' });
      }

      const filter: Record<string, unknown> = {};
      if (req.query.projectId) {
        filter['projectId'] = req.query.projectId;
      }
      if (req.query.status) {
        filter['status'] = req.query.status;
      }

      const docs = await incidentsCol
        .find(filter)
        .sort({ openedAt: -1 })
        .toArray();

      const incidents = docs.map((d) => ({
        ...d,
        id: String(d._id),
      }));

      return reply.send({ incidents });
    },
  );

  // GET /v1/incidents/:id
  app.get<{ Params: { id: string } }>('/v1/incidents/:id', async (req, reply) => {
    const { id } = req.params;
    let query: Record<string, unknown>;

    try {
      query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
    } catch {
      query = { _id: id };
    }

    const doc = await incidentsCol.findOne(query);
    if (!doc) {
      return reply.code(404).send({ error: 'Incident not found' });
    }

    return reply.send({
      ...doc,
      id: String(doc._id),
    });
  });
}
