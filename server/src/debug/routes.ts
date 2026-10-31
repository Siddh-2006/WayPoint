/**
 * server/src/debug/routes.ts
 *
 * Fastify routes for Query Explain and Index Verification:
 *   GET /v1/debug/explain  - runs explain("executionStats") against 4 core queries
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { runQueryExplains } from './explain.js';

export async function debugRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get<{ Querystring: { projectId?: string } }>('/v1/debug/explain', async (req, reply) => {
    const projectId = req.query.projectId ?? 'demo';
    try {
      const report = await runQueryExplains(db, projectId);
      return reply.send(report);
    } catch (err: any) {
      return reply.code(500).send({ error: `Explain failed: ${err.message}` });
    }
  });
}
