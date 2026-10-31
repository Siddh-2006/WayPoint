/**
 * server/src/narrate/routes.ts
 *
 * Fastify routes for Evidence-Cited Narration:
 *   POST /v1/incidents/:id/narrate   - generate or refresh cited narrative
 *   GET /v1/incidents/:id/narration  - retrieve existing narration or synthesize on demand
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { narrateIncident } from './service.js';

export async function narrationRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // POST /v1/incidents/:id/narrate
  app.post<{
    Params: { id: string };
    Body?: { forceRefresh?: boolean };
  }>('/v1/incidents/:id/narrate', async (req, reply) => {
    const { id } = req.params;
    const forceRefresh = Boolean(req.body?.forceRefresh);

    try {
      const result = await narrateIncident(db, id, { forceRefresh });
      return reply.send(result);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.code(404).send({ error: err.message });
      }
      return reply.code(500).send({ error: `Narration failed: ${err.message}` });
    }
  });

  // GET /v1/incidents/:id/narration
  app.get<{ Params: { id: string } }>('/v1/incidents/:id/narration', async (req, reply) => {
    const { id } = req.params;

    try {
      const result = await narrateIncident(db, id, { forceRefresh: false });
      return reply.send(result);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.code(404).send({ error: err.message });
      }
      return reply.code(500).send({ error: `Narration lookup failed: ${err.message}` });
    }
  });
}
