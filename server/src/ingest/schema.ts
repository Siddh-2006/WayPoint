/**
 * server/src/ingest/schema.ts
 *
 * Zod schema for inbound events.  Must stay aligned with the DB $jsonSchema
 * validator defined in scripts/src/init-db.ts.
 */

import { z } from 'zod';

export const EventTypeEnum = z.enum([
  'run_start',
  'context',
  'step',
  'tool_call',
  'retrieval',
  'output',
  'run_end',
  'error',
]);

export const EventStatusEnum = z.enum(['ok', 'error', 'violation']);

/**
 * Single inbound event.
 * _id = eventId supplied by the client (string, unique across the collection).
 */
export const EventSchema = z.object({
  eventId: z.string().min(1, 'eventId is required'),
  projectId: z.string().min(1, 'projectId is required'),
  runId: z.string().min(1, 'runId is required'),
  seq: z
    .number()
    .int('seq must be an integer')
    .nonnegative('seq must be >= 0'),
  ts: z
    .string()
    .datetime({ message: 'ts must be an ISO 8601 datetime string' })
    .transform((s) => new Date(s)),
  type: EventTypeEnum,
  status: EventStatusEnum,
  stepKey: z.string().min(1, 'stepKey is required'),
  contextPayload: z.record(z.unknown()),
});

export type EventInput = z.input<typeof EventSchema>;
export type EventDoc = z.output<typeof EventSchema>;

/** Batch ingestion — up to 500 events per request. */
export const BatchSchema = z
  .array(EventSchema)
  .min(1, 'batch must contain at least one event')
  .max(500, 'batch may not exceed 500 events');

/**
 * Accept either a single event object or an array.
 * Always returns an array to normalise downstream handling.
 */
export const IngestBodySchema = z
  .union([EventSchema, BatchSchema])
  .transform((v) => (Array.isArray(v) ? v : [v]));
