/**
 * server/src/preflight/routes.ts
 *
 * Fastify routes for Preflight verification:
 *   - POST /v1/preflight      (x-api-key; private/public)
 *   - POST /v1/demo/preflight (zero-key public demo endpoint)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { runPreflight } from './service.js';
import { BaselinePrerequisiteError } from '../replay/engine.js';
import type { ContextData } from '../contexts/hash.js';

function isAuthorized(apiKey: string | undefined): boolean {
  if (!apiKey) return false;
  return config.API_KEYS.includes(apiKey);
}

function isPublicProject(projectId: string): boolean {
  return config.READ_PUBLIC_PROJECTS.includes(projectId);
}

const ContextSchema = z.object({
  model: z.string().min(1),
  promptText: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  toolSchemas: z.record(z.unknown()).optional(),
  deps: z.record(z.unknown()).optional(),
});

const PreflightBodySchema = z.object({
  projectId: z.string().min(1),
  proposedContext: ContextSchema,
});

const DemoPreflightSchema = z.object({
  scenarioId: z.enum(['good', 'bad_deploy', 'model_only', 'prompt_only']).optional(),
  proposedContext: ContextSchema.optional(),
  projectId: z.string().optional().default('demo'),
});

const DEMO_SCENARIO_CONTEXTS: Record<string, ContextData> = {
  good: {
    model: 'v1',
    promptText: 'Extract invoices accurately.\nAlways use camelCase keys in tool arguments.\nReturn JSON.',
    config: { chunkSize: 512, temperature: 0.5 },
    toolSchemas: { create_invoice: { type: 'function' } },
    deps: { extractor: '1.0.0' },
  },
  bad_deploy: {
    model: 'v2',
    promptText: 'Extract invoices accurately.\nEnsure total is correct.\nReturn JSON.',
    config: { chunkSize: 256, temperature: 0.5 },
    toolSchemas: { create_invoice: { type: 'function' } },
    deps: { extractor: '1.0.0' },
  },
  model_only: {
    model: 'v2',
    promptText: 'Extract invoices accurately.\nAlways use camelCase keys in tool arguments.\nReturn JSON.',
    config: { chunkSize: 512, temperature: 0.5 },
    toolSchemas: { create_invoice: { type: 'function' } },
    deps: { extractor: '1.0.0' },
  },
  prompt_only: {
    model: 'v1',
    promptText: 'Extract invoices accurately.\nEnsure total is correct.\nReturn JSON.',
    config: { chunkSize: 512, temperature: 0.5 },
    toolSchemas: { create_invoice: { type: 'function' } },
    deps: { extractor: '1.0.0' },
  },
};

export async function preflightRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // POST /v1/preflight
  app.post('/v1/preflight', async (req, reply) => {
    const parseResult = PreflightBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(422).send({ error: 'Validation failed', issues: parseResult.error.errors });
    }

    const { projectId, proposedContext } = parseResult.data;
    const apiKey = req.headers['x-api-key'] as string | undefined;

    if (!isPublicProject(projectId) && !isAuthorized(apiKey)) {
      return reply.code(401).send({ error: 'Unauthorized: valid x-api-key required' });
    }

    try {
      const result = await runPreflight(db, {
        projectId,
        proposedContext: proposedContext as ContextData,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof BaselinePrerequisiteError) {
        return reply.code(409).send({
          error: 'no baseline yet',
          message: err.message,
          have: err.have,
          need: err.need,
        });
      }
      req.log.error(err, 'Preflight verification failed');
      return reply.code(500).send({ error: 'Preflight failed', message: String(err) });
    }
  });

  // POST /v1/demo/preflight — zero-key public demo route
  app.post('/v1/demo/preflight', async (req, reply) => {
    const parseResult = DemoPreflightSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(422).send({ error: 'Validation failed', issues: parseResult.error.errors });
    }

    const { scenarioId, proposedContext, projectId } = parseResult.data;

    const targetContext =
      proposedContext ?? (scenarioId ? DEMO_SCENARIO_CONTEXTS[scenarioId] : undefined);

    if (!targetContext) {
      return reply.code(400).send({ error: 'Must provide scenarioId or proposedContext' });
    }

    try {
      const result = await runPreflight(db, {
        projectId,
        proposedContext: targetContext as ContextData,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof BaselinePrerequisiteError) {
        return reply.code(409).send({
          error: 'no baseline yet',
          message: err.message,
          have: err.have,
          need: err.need,
        });
      }
      req.log.error(err, 'Demo preflight failed');
      return reply.code(500).send({ error: 'Demo preflight failed', message: String(err) });
    }
  });
}
