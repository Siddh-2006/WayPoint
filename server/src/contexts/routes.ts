/**
 * server/src/contexts/routes.ts
 *
 * Fastify routes for Contexts and Context Diff:
 *   POST /v1/contexts       — register / upsert immutable context by contentHash
 *   GET  /v1/contexts/:hash — retrieve context by contentHash (404 if not found)
 *   GET  /v1/diff           — diff between two context hashes: ?from=&to= (404 if either missing)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MongoServerError } from 'mongodb';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { hashContext, type ContextData } from './hash.js';
import { diffContexts, type ContextChange } from './diff.js';

import { isPublicDemoProject } from '../demo/sandbox.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const CreateContextSchema = z.object({
  projectId: z.string().optional().default('default'),
  model: z.string().min(1, 'model is required'),
  promptText: z.string(),
  config: z.record(z.unknown()).optional().default({}),
  toolSchemas: z.record(z.unknown()).optional().default({}),
  deps: z.record(z.unknown()).optional().default({}),
});

export type CreateContextInput = z.infer<typeof CreateContextSchema>;

// ─── Auth helper ─────────────────────────────────────────────────────────────

function requireApiKey(req: FastifyRequest, reply: FastifyReply): boolean {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || !config.API_KEYS.includes(key)) {
    reply.code(401).send({ error: 'Unauthorized: invalid or missing x-api-key' });
    return false;
  }
  return true;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function contextRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const contextsCol = db.collection('contexts');
  const deploymentsCol = db.collection('deployments');

  // ── POST /v1/contexts ──────────────────────────────────────────────────────
  app.post('/v1/contexts', async (req, reply) => {
    const parseResult = CreateContextSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(422).send({
        error: 'Validation failed',
        issues: parseResult.error.errors,
      });
    }

    const { projectId } = parseResult.data;
    const isPublic = isPublicDemoProject(projectId);
    const key = req.headers['x-api-key'];
    const hasValidKey = typeof key === 'string' && config.API_KEYS.includes(key);

    if (!isPublic && !hasValidKey) {
      return reply.code(401).send({ error: 'Unauthorized: invalid or missing x-api-key' });
    }

    const { projectId, model, promptText, config: cfg, toolSchemas, deps } = parseResult.data;

    const ctxData: ContextData = {
      model,
      promptText,
      config: cfg,
      toolSchemas,
      deps,
    };

    const contentHash = hashContext(ctxData);

    // Look up current project live hash to assign parentHash
    const currentDep = await deploymentsCol.findOne<{ live?: string }>({ projectId });
    const parentHash = currentDep?.live ?? null;

    let created = false;

    try {
      await contextsCol.insertOne({
        contentHash,
        model,
        promptText,
        config: cfg,
        toolSchemas,
        deps,
        parentHash,
        createdAt: new Date(),
      });
      created = true;

      // Update deployments record for the project
      await deploymentsCol.updateOne(
        { projectId },
        {
          $set: { live: contentHash },
          $push: { history: contentHash } as never,
          $inc: { rev: 1 },
        },
        { upsert: true },
      );
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        // Idempotent: already exists, treat as duplicate/success
        created = false;
      } else {
        req.log.error({ err }, 'Failed to insert context');
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }

    // Compute diff against parent if parent exists and is different
    let changes: ContextChange[] = [];
    if (parentHash && parentHash !== contentHash) {
      const parentDoc = await contextsCol.findOne<ContextData>({ contentHash: parentHash });
      if (parentDoc) {
        changes = diffContexts(parentDoc, ctxData);
      }
    }

    const status = created ? 201 : 200;
    return reply.code(status).send({
      hash: contentHash,
      created,
      changes,
    });
  });

  // ── GET /v1/contexts/:hash ─────────────────────────────────────────────────
  app.get<{ Params: { hash: string } }>('/v1/contexts/:hash', async (req, reply) => {
    const { hash } = req.params;
    const doc = await contextsCol.findOne(
      { contentHash: hash },
      { projection: { _id: 0 } },
    );

    if (!doc) {
      return reply.code(404).send({ error: 'Context not found' });
    }

    return reply.send(doc);
  });

  // ── GET /v1/diff?from=&to= ─────────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string } }>('/v1/diff', async (req, reply) => {
    const { from, to } = req.query;

    if (!from || !to) {
      return reply.code(400).send({ error: 'Both "from" and "to" query parameters are required' });
    }

    const [fromDoc, toDoc] = await Promise.all([
      contextsCol.findOne<ContextData>({ contentHash: from }),
      contextsCol.findOne<ContextData>({ contentHash: to }),
    ]);

    if (!fromDoc || !toDoc) {
      return reply.code(404).send({
        error: 'Context not found',
        missing: !fromDoc ? 'from' : 'to',
      });
    }

    const changes = diffContexts(fromDoc, toDoc);
    return reply.send({ from, to, changes });
  });
}

