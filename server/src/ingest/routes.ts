/**
 * server/src/ingest/routes.ts
 *
 * Fastify routes:
 *   POST /v1/events   — ingest one event or a batch (max 500, body limit 1 MB)
 *   GET  /v1/runs/:runId/events  — retrieve events sorted by seq
 *
 * Auth: x-api-key header must match one of config.API_KEYS on write routes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MongoServerError } from 'mongodb';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { IngestBodySchema } from './schema.js';
import { redact } from './redact.js';
import type { EventDoc } from './schema.js';
import { checkRun, type ContractDoc } from '../contracts/check.js';

import { isPublicDemoProject } from '../demo/sandbox.js';

/** Document shape stored in the `events` collection (string _id). */
interface StoredEvent {
  _id: string;
  projectId: string;
  runId: string;
  seq: number;
  ts: Date;
  type: EventDoc['type'];
  status: EventDoc['status'];
  stepKey: string;
  contextPayload: Record<string, unknown>;
  insertedAt: Date;
}

// ─── Auth helper ─────────────────────────────────────────────────────────────

function requireApiKey(req: FastifyRequest, reply: FastifyReply): boolean {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || !config.API_KEYS.includes(key)) {
    reply.code(401).send({ error: 'Unauthorized: invalid or missing x-api-key' });
    return false;
  }
  return true;
}

// ─── Result type ─────────────────────────────────────────────────────────────

type EventResult =
  | { status: 'inserted'; eventId: string }
  | { status: 'duplicate_ignored'; eventId: string }
  | { status: 'rejected'; eventId: string; errors: unknown };

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /v1/events ────────────────────────────────────────────────────────
  app.post(
    '/v1/events',
    {
      bodyLimit: 1_048_576, // 1 MB
      config: { rawBody: false },
    },
    async (req, reply) => {
      // 1. Parse & validate body first
      const parseResult = IngestBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          error: 'Validation failed',
          issues: parseResult.error.errors,
        });
      }

      const events = parseResult.data; // always an array after the transform
      const isPublicBatch = events.every((e) => isPublicDemoProject(e.projectId));
      if (!isPublicBatch && !requireApiKey(req, reply)) return;

      // 2. Build docs to insert
      const results: EventResult[] = [];
      const docsToInsert: StoredEvent[] = [];

      for (const ev of events) {
        docsToInsert.push({
          _id: ev.eventId,
          projectId: ev.projectId,
          runId: ev.runId,
          seq: ev.seq,
          ts: ev.ts,
          type: ev.type,
          status: ev.status,
          stepKey: ev.stepKey,
          // Redact before storing — secrets never hit the DB
          contextPayload: redact(ev.contextPayload) as Record<string, unknown>,
          insertedAt: new Date(),
        });
      }

      // 3. Bulk insert — ordered:false so one duplicate doesn't stop the rest
      const eventsCol = getDb().collection<StoredEvent>('events');
      try {
        if (docsToInsert.length > 0) {
          await eventsCol.insertMany(docsToInsert, { ordered: false });
          for (const doc of docsToInsert) {
            results.push({ status: 'inserted', eventId: doc._id });
          }
        }
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) {
          // Partial-success: some inserted, some duplicated.
          // writeErrors lists the duplicate indices.
          const writeErrors: Array<{ index: number }> =
            (err as MongoServerError & { writeErrors?: Array<{ index: number }> })
              .writeErrors ?? [];
          const duplicateIndices = new Set(writeErrors.map((e) => e.index));

          for (let i = 0; i < docsToInsert.length; i++) {
            const doc = docsToInsert[i];
            if (!doc) continue;
            if (duplicateIndices.has(i)) {
              results.push({ status: 'duplicate_ignored', eventId: doc._id });
            } else {
              results.push({ status: 'inserted', eventId: doc._id });
            }
          }
        } else {
          req.log.error({ err }, 'insertMany unexpected error');
          return reply.code(500).send({ error: 'Internal server error' });
        }
      }

      // Check contracts if any run has completed
      const runEndDocs = docsToInsert.filter((d) => d.type === 'run_end');
      if (runEndDocs.length > 0) {
        const db = getDb();
        const runsCol = db.collection('runs');
        const contractsCol = db.collection<ContractDoc>('contracts');

        for (const red of runEndDocs) {
          const runEvents = await eventsCol
            .find({ runId: red.runId })
            .sort({ seq: 1 })
            .toArray();

          const contracts = await contractsCol
            .find({ projectId: red.projectId })
            .toArray();

          if (contracts.length > 0) {
            const violations = checkRun(contracts, runEvents);
            await runsCol.updateOne(
              { runId: red.runId },
              {
                $set: {
                  violations,
                  status: violations.length > 0 ? 'failed' : 'completed',
                  endedAt: red.ts,
                },
              },
              { upsert: true },
            );
          }
        }
      }

      const code = results.every((r) => r.status === 'inserted') ? 201 : 207;
      return reply.code(code).send({ results });
    },
  );

  // ── GET /v1/runs/:runId/events ─────────────────────────────────────────────
  app.get<{ Params: { runId: string } }>(
    '/v1/runs/:runId/events',
    async (req, reply) => {
      const { runId } = req.params;
      const eventsCol = getDb().collection<StoredEvent>('events');
      const docs = await eventsCol
        .find({ runId }, { projection: { _id: 0 } })
        .sort({ seq: 1 })
        .toArray();
      return reply.send({ runId, events: docs });
    },
  );
}
