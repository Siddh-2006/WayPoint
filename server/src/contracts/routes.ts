/**
 * server/src/contracts/routes.ts
 *
 * Fastify routes for Contract Mining & Retrieval:
 *   POST /v1/projects/:projectId/baseline  — mine and set baseline contract (x-api-key)
 *   GET  /v1/contracts                    — fetch contracts for a project
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { mineContracts } from './mine.js';

function requireApiKey(req: FastifyRequest, reply: FastifyReply): boolean {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || !config.API_KEYS.includes(key)) {
    reply.code(401).send({ error: 'Unauthorized: invalid or missing x-api-key' });
    return false;
  }
  return true;
}

const BaselineBodySchema = z.object({
  contextHash: z.string().min(1, 'contextHash is required'),
});

export async function contractRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // POST /v1/projects/:projectId/baseline
  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/baseline',
    async (req, reply) => {
      if (!requireApiKey(req, reply)) return;

      const { projectId } = req.params;
      const parseResult = BaselineBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          error: 'Validation failed',
          issues: parseResult.error.errors,
        });
      }

      const { contextHash } = parseResult.data;
      const result = await mineContracts(db, projectId, contextHash);
      return reply.send(result);
    },
  );

  // GET /v1/contracts?projectId=
  app.get<{ Querystring: { projectId?: string } }>('/v1/contracts', async (req, reply) => {
    const projectId = req.query.projectId ?? 'demo';
    const isPublic = config.READ_PUBLIC_PROJECTS.includes(projectId);
    const key = req.headers['x-api-key'];
    const hasValidKey = typeof key === 'string' && config.API_KEYS.includes(key);

    if (!isPublic && !hasValidKey) {
      return reply.code(403).send({ error: 'Forbidden: project requires x-api-key' });
    }

    const contracts = await db
      .collection('contracts')
      .find({ projectId }, { projection: { _id: 0 } })
      .toArray();

    return reply.send({ projectId, contracts });
  });
}
