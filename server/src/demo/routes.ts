/**
 * server/src/demo/routes.ts
 *
 * Server-side execution of simulated demo scenarios.
 * Enables the dashboard UI and judges to trigger agent runs with zero client-side keys.
 *
 * Scenarios:
 *   - good:        model v1 + fixed prompt (camelCase) + chunkSize 512
 *   - bad_deploy:  model v2 + old prompt + chunkSize 256 (triggers planted bug)
 *   - model_only:  model v2 + fixed prompt (safe)
 *   - prompt_only: model v1 + old prompt (safe)
 */

import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { hashContext, type ContextData } from '../contexts/hash.js';
import { runAgent, type InvoiceInput } from './invoice-agent.js';
import { redact } from '../ingest/redact.js';
import { checkRun, type ContractDoc } from '../contracts/check.js';
import { mineContracts } from '../contracts/mine.js';
import {
  deriveSandbox,
  acquireResetLock,
  releaseResetLock,
  checkRateLimit,
  cleanupExpiredSandboxes,
  isPublicDemoProject,
  assertSandboxCapacity,
} from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, './corpus.json');

let corpusCache: InvoiceInput[] | null = null;

function getCorpus(): InvoiceInput[] {
  if (!corpusCache) {
    const raw = readFileSync(CORPUS_PATH, 'utf-8');
    corpusCache = JSON.parse(raw) as InvoiceInput[];
  }
  return corpusCache;
}

const ScenarioEnum = z.enum(['good', 'bad_deploy', 'model_only', 'prompt_only']);

const ScenarioBodySchema = z.object({
  scenarioId: ScenarioEnum,
  projectId: z.string().optional(),
});

interface ScenarioDefinition {
  context: ContextData;
  description: string;
}

const SCENARIOS: Record<z.infer<typeof ScenarioEnum>, ScenarioDefinition> = {
  good: {
    description: 'Baseline: model v1, camelCase prompt, chunk size 512 (clean run)',
    context: {
      model: 'v1',
      promptText: 'Extract invoices accurately.\nAlways use camelCase keys in tool arguments.\nReturn JSON.',
      config: { chunkSize: 512, temperature: 0.5 },
      toolSchemas: { create_invoice: { type: 'function' } },
      deps: { extractor: '1.0.0' },
    },
  },
  bad_deploy: {
    description: 'Bad deploy: model v2, prompt missing camelCase rule, chunk size 256 (causes silent failure)',
    context: {
      model: 'v2',
      promptText: 'Extract invoices accurately.\nEnsure total is correct.\nReturn JSON.',
      config: { chunkSize: 256, temperature: 0.5 },
      toolSchemas: { create_invoice: { type: 'function' } },
      deps: { extractor: '1.0.0' },
    },
  },
  model_only: {
    description: 'Model upgraded to v2 but camelCase prompt preserved (safe)',
    context: {
      model: 'v2',
      promptText: 'Extract invoices accurately.\nAlways use camelCase keys in tool arguments.\nReturn JSON.',
      config: { chunkSize: 512, temperature: 0.5 },
      toolSchemas: { create_invoice: { type: 'function' } },
      deps: { extractor: '1.0.0' },
    },
  },
  prompt_only: {
    description: 'Old prompt on model v1 with chunk size 512 (safe)',
    context: {
      model: 'v1',
      promptText: 'Extract invoices accurately.\nEnsure total is correct.\nReturn JSON.',
      config: { chunkSize: 512, temperature: 0.5 },
      toolSchemas: { create_invoice: { type: 'function' } },
      deps: { extractor: '1.0.0' },
    },
  },
};

interface StoredEventDoc {
  _id: string;
  projectId: string;
  runId: string;
  seq: number;
  ts: Date;
  type: string;
  status: string;
  stepKey: string;
  contextPayload: Record<string, unknown>;
  insertedAt: Date;
}

interface StoredRunDoc {
  runId: string;
  projectId: string;
  contextHash: string;
  status: 'completed' | 'running' | 'failed';
  violations: unknown[];
  startedAt: Date;
  endedAt: Date;
  inputId: string;
}

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const contextsCol = db.collection('contexts');
  const runsCol = db.collection<StoredRunDoc>('runs');
  const eventsCol = db.collection<StoredEventDoc>('events');

  // GET /v1/demo/runs — fetch recent runs for initial dashboard hydration
  app.get<{ Querystring: { projectId?: string } }>('/v1/demo/runs', async (req) => {
    const pId = req.query.projectId || 'demo';
    const recent = await runsCol
      .find({ projectId: { $regex: new RegExp(`^${pId}`) } })
      .sort({ startedAt: -1 })
      .limit(50)
      .toArray();
    return { runs: recent.reverse() };
  });

  // POST /v1/demo/run — public/internal demo trigger (browser needs no key)
  app.post('/v1/demo/run', async (req, reply) => {
    const parseResult = ScenarioBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(422).send({
        error: 'Validation failed',
        issues: parseResult.error.errors,
      });
    }

    let targetProjectId = parseResult.data.projectId;
    if (!targetProjectId) {
      const sessionHdr = req.headers['x-demo-session'] as string | undefined;
      const derived = deriveSandbox(sessionHdr);
      targetProjectId = derived ? derived.projectId : 'demo';
    }
    const projectId = targetProjectId;

    // Safety: only permit demo or demo-* sandboxes
    if (!projectId.startsWith('demo-') && projectId !== 'demo') {
      return reply.code(403).send({ error: 'Forbidden: demo routes only permit demo- sandboxes' });
    }

    if (projectId.startsWith('demo-')) {
      const hasCap = await assertSandboxCapacity(db, projectId);
      if (!hasCap) {
        return reply.code(429).send({ error: `Max concurrent sandboxes limit (${config.MAX_SANDBOXES}) reached` });
      }
    }

    const { scenarioId } = parseResult.data;
    const scenario = SCENARIOS[scenarioId];
    const contextData = scenario.context;

    // 1. Calculate & register context
    const contextHash = hashContext(contextData);
    await contextsCol
      .updateOne(
        { contentHash: contextHash },
        {
          $setOnInsert: {
            contentHash: contextHash,
            model: contextData.model,
            promptText: contextData.promptText,
            config: contextData.config ?? {},
            toolSchemas: contextData.toolSchemas ?? {},
            deps: contextData.deps ?? {},
            parentHash: null,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      )
      .catch(() => undefined);

    // 2. Load corpus & fetch active contracts for this project
    const corpus = getCorpus();
    const contracts = await db
      .collection<ContractDoc>('contracts')
      .find({ projectId })
      .toArray();

    const batchRunId = `demo_${scenarioId}_${Date.now()}`;
    const allEvents: StoredEventDoc[] = [];
    const runDocs: StoredRunDoc[] = [];

    // 3. Execute simulated agent for all 20 invoices
    for (const input of corpus) {
      const runId = `${batchRunId}_${input.id}`;
      const now = new Date();

      const result = runAgent({
        context: contextData,
        input,
        seed: input.id,
      });

      // Check run steps against contracts
      const checkEvents = result.steps.map((s, idx) => ({
        eventId: `${runId}:${idx + 1}`,
        runId,
        type: s.type,
        status: s.status,
        stepKey: s.stepKey,
        contextPayload: s.contextPayload,
      }));
      const violations = contracts.length > 0 ? checkRun(contracts, checkEvents) : [];

      let seq = 0;

      // Start run event
      allEvents.push({
        _id: `${runId}:${seq}`,
        projectId,
        runId,
        seq: seq++,
        ts: now,
        type: 'run_start',
        status: 'ok',
        stepKey: 'run_start',
        contextPayload: redact({ input, contextHash }) as Record<string, unknown>,
        insertedAt: now,
      });

      // Intermediate steps
      for (const step of result.steps) {
        allEvents.push({
          _id: `${runId}:${seq}`,
          projectId,
          runId,
          seq: seq++,
          ts: now,
          type: step.type,
          status: step.status,
          stepKey: step.stepKey,
          contextPayload: redact(step.contextPayload) as Record<string, unknown>,
          insertedAt: now,
        });
      }

      // Run end event
      allEvents.push({
        _id: `${runId}:${seq}`,
        projectId,
        runId,
        seq: seq++,
        ts: now,
        type: 'run_end',
        status: 'ok',
        stepKey: 'run_end',
        contextPayload: redact({ output: result.output }) as Record<string, unknown>,
        insertedAt: now,
      });

      runDocs.push({
        runId,
        projectId,
        contextHash,
        status: violations.length > 0 ? 'failed' : 'completed',
        violations,
        startedAt: now,
        endedAt: now,
        inputId: input.id,
      });
    }

    // 4. Bulk insert events & runs
    await eventsCol.insertMany(allEvents, { ordered: false }).catch(() => undefined);
    await runsCol.insertMany(runDocs, { ordered: false }).catch(() => undefined);

    // If running good baseline scenario, auto-mine contracts so baseline is established
    if (scenarioId === 'good') {
      await mineContracts(db, projectId, contextHash).catch(() => undefined);
    }

    return reply.send({
      simulated: true,
      scenarioId,
      description: scenario.description,
      contextHash,
      runsCount: corpus.length,
      eventsCount: allEvents.length,
      status: 'ok',
    });
  });

  // POST /v1/demo/story/reset — Reset and seed the caller's per-session sandbox
  app.post('/v1/demo/story/reset', async (req, reply) => {
    // 1. Rate limit per IP / session
    const ip = req.ip || '127.0.0.1';
    const sessionHdr = req.headers['x-demo-session'] as string | undefined;
    const rateKey = `reset:${sessionHdr || ip}`;
    const rl = checkRateLimit(rateKey, 20); // 20 resets per minute limit
    if (!rl.allowed) {
      return reply.code(429).send({ error: 'Too many requests: rate limit exceeded for demo reset' });
    }

    // 2. Resolve sandbox from header or query
    const sandbox = deriveSandbox(sessionHdr || (req.query as any)?.sessionId);
    if (!sandbox) {
      return reply.code(400).send({
        error: 'Invalid or missing x-demo-session header (must be a valid UUID)',
      });
    }

    const { projectId } = sandbox;
    // Strict safety check: Must start with "demo-"
    if (!projectId.startsWith('demo-')) {
      return reply.code(403).send({ error: 'Forbidden: invalid sandbox prefix' });
    }

    // 3. Concurrency lock per sandbox
    if (!acquireResetLock(projectId)) {
      return reply.code(409).send({ error: 'Sandbox reset already in progress for this session' });
    }

    const hasCap = await assertSandboxCapacity(db, projectId);
    if (!hasCap) {
      releaseResetLock(projectId);
      return reply.code(429).send({ error: `Max concurrent sandboxes limit (${config.MAX_SANDBOXES}) reached` });
    }

    try {
      // 4. Delete ONLY documents for this specific sandbox projectId
      const collections = [
        'runs',
        'events',
        'contexts',
        'deployments',
        'contracts',
        'incidents',
        'experiments',
        'lessons',
        'replayCache',
      ];
      for (const colName of collections) {
        await db.collection(colName).deleteMany({ projectId });
      }

      // 5. Seed baseline context & runs
      const baselineContext = SCENARIOS.good.context;
      const baselineHash = hashContext(baselineContext);

      await db.collection('contexts').updateOne(
        { contentHash: baselineHash },
        {
          $setOnInsert: {
            contentHash: baselineHash,
            model: baselineContext.model,
            promptText: baselineContext.promptText,
            config: baselineContext.config ?? {},
            toolSchemas: baselineContext.toolSchemas ?? {},
            deps: baselineContext.deps ?? {},
            parentHash: null,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );

      // Seed 12 baseline runs
      const corpus = getCorpus();
      const baseRuns = corpus.slice(0, 12).map((input, idx) => {
        const runId = `demo_base_${Date.now()}_${input.id}`;
        return {
          runId,
          projectId,
          contextHash: baselineHash,
          status: 'completed' as const,
          violations: [],
          startedAt: new Date(Date.now() - (12 - idx) * 60_000),
          endedAt: new Date(Date.now() - (12 - idx) * 60_000),
          inputId: input.id,
        };
      });
      await runsCol.insertMany(baseRuns, { ordered: false });

      // Record deployment baseline
      await db.collection('deployments').updateOne(
        { projectId },
        { $set: { projectId, baselineHash, updatedAt: new Date() } },
        { upsert: true },
      );

      // Auto-mine contract
      await mineContracts(db, projectId, baselineHash);

      // 6. Reseed SEEDED lessons (tagged with source: 'seed' and badge)
      const seededLesson = {
        _id: `seed_lesson_${projectId}`,
        incidentId: `seed_inc_${projectId}`,
        projectId,
        symptom: 'Contract violation: required key invoiceId missing; found similar key invoice_id in tool arguments (1 occurrences).',
        culprit: { units: ['model', 'prompt'], shapley: { model: 0.7, prompt: 0.3 }, interaction: true },
        changeTypes: ['model', 'prompt'],
        fix: 'Enforce camelCase parameter naming in tool arguments',
        source: 'seed' as const,
        status: 'active' as const,
        embedding: [],
        violatedRules: [
          { rule: 'unexpected_similar_key' as const, expectedKey: 'invoiceId', tool: 'create_invoice' },
        ],
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
      };
      await db.collection('lessons').insertOne(seededLesson as any);

      return reply.send({
        status: 'ok',
        projectId,
        sessionId: sandbox.sessionId,
        baselineHash,
        baselineRunsSeeded: baseRuns.length,
        seededLessonsCount: 1,
        message: 'Sandbox cleanly reset and seeded',
      });
    } finally {
      releaseResetLock(projectId);
    }
  });

  // POST /v1/demo/sandbox/cleanup — Run background TTL cleanup
  app.post('/v1/demo/sandbox/cleanup', async (_req, reply) => {
    const result = await cleanupExpiredSandboxes(db);
    return reply.send(result);
  });
}
