/**
 * server/src/lessons/routes.ts
 *
 * Fastify routes for episodic memory (lessons) lifecycle and recall:
 *   - POST  /v1/incidents/:id/resolve  (x-api-key; public for demo)
 *   - PATCH /v1/lessons/:id            (x-api-key)
 *   - GET   /v1/lessons?projectId=...  (public for demo; x-api-key for private)
 *   - POST  /v1/lessons/recall         (query recall)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { resolveIncident, patchLesson, listLessons } from './service.js';
import { recallLessons } from './recall.js';

function isAuthorized(apiKey: string | undefined): boolean {
  if (!apiKey) return false;
  return config.API_KEYS.includes(apiKey);
}

function isPublicProject(projectId: string): boolean {
  return config.READ_PUBLIC_PROJECTS.includes(projectId);
}

const ResolveBodySchema = z.object({
  fix: z.string().min(1, 'fix description is required'),
  note: z.string().optional(),
  source: z.enum(['incident', 'seed']).optional(),
});

const PatchBodySchema = z.object({
  status: z.enum(['active', 'corrected', 'expired']).optional(),
  note: z.string().optional(),
});

const RecallBodySchema = z.object({
  projectId: z.string(),
  query: z.string().min(1),
  minScore: z.number().optional(),
});

export async function lessonRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // POST /v1/incidents/:id/resolve
  app.post<{ Params: { id: string } }>('/v1/incidents/:id/resolve', async (req, reply) => {
    const { id } = req.params;
    const parseResult = ResolveBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(422).send({ error: 'Validation failed', issues: parseResult.error.errors });
    }

    const apiKey = req.headers['x-api-key'] as string | undefined;

    // Check incident to see which project it belongs to
    const inc = await db.collection('incidents').findOne({
      $or: [{ _id: id as any }, { incidentId: id }],
    });
    if (!inc) {
      return reply.code(404).send({ error: 'Incident not found' });
    }

    const projectId = inc['projectId'] as string;
    if (!isPublicProject(projectId) && !isAuthorized(apiKey)) {
      return reply.code(401).send({ error: 'Unauthorized: valid x-api-key required' });
    }

    try {
      const lesson = await resolveIncident(db, id, parseResult.data);
      return reply.code(200).send({ ok: true, lesson });
    } catch (err) {
      req.log.error(err, 'Failed to resolve incident into lesson');
      return reply.code(500).send({ error: 'Failed to resolve incident', message: String(err) });
    }
  });

  // PATCH /v1/lessons/:id
  app.patch<{ Params: { id: string } }>('/v1/lessons/:id', async (req, reply) => {
    const { id } = req.params;
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!isAuthorized(apiKey)) {
      return reply.code(401).send({ error: 'Unauthorized: valid x-api-key required' });
    }

    const parseResult = PatchBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(422).send({ error: 'Validation failed', issues: parseResult.error.errors });
    }

    const updated = await patchLesson(db, id, parseResult.data);
    if (!updated) {
      return reply.code(404).send({ error: 'Lesson not found' });
    }

    return reply.send({ ok: true, lesson: updated });
  });

  // GET /v1/lessons?projectId=...
  app.get<{ Querystring: { projectId?: string } }>('/v1/lessons', async (req, reply) => {
    const { projectId } = req.query;
    if (!projectId) {
      return reply.code(400).send({ error: 'Missing projectId query parameter' });
    }

    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!isPublicProject(projectId) && !isAuthorized(apiKey)) {
      return reply.code(403).send({ error: 'Forbidden: project requires x-api-key' });
    }

    const lessons = await listLessons(db, projectId);
    return reply.send({ lessons });
  });

  // POST /v1/lessons/recall
  app.post('/v1/lessons/recall', async (req, reply) => {
    const parseResult = RecallBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(422).send({ error: 'Validation failed', issues: parseResult.error.errors });
    }

    const { projectId, query, minScore } = parseResult.data;
    const apiKey = req.headers['x-api-key'] as string | undefined;

    if (!isPublicProject(projectId) && !isAuthorized(apiKey)) {
      return reply.code(403).send({ error: 'Forbidden: project requires x-api-key' });
    }

    const response = await recallLessons(db, { projectId, query, minScore });
    return reply.send(response);
  });
}

