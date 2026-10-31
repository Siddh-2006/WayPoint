/**
 * server/src/db/init.ts
 *
 * Idempotent DB initialisation — single source of truth.
 * Called from server startup and from gate/CLI scripts.
 *
 * Design choices:
 *   - Uses collMod when a collection already exists to keep validators current.
 *   - All createIndex calls are idempotent (MongoDB ignores same name+key).
 *   - Atlas M0 limit: 3 search/vector indexes total; we use 2.
 *   - Search index creation is best-effort: failures log a warning but do NOT
 *     crash the server. The caller checks the returned SearchIndexStatus.
 *   - EMBED_DIM read from process.env so gates and CLI can override it.
 */

import { type Db, type Document } from 'mongodb';
import { syncLessonEmbeddings } from '../lessons/service.js';

// ─── Search-index status (module-level so /health can read it) ────────────────

export type SearchIndexStatus = 'ready' | 'pending' | 'failed';

/** Updated by initDb(); read by /health. */
export let searchIndexStatus: SearchIndexStatus = 'pending';

// ─── JSON Schema validators ───────────────────────────────────────────────────

const validators: Record<string, Document> = {
  events: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id', 'projectId', 'runId', 'seq', 'ts',
        'type', 'status', 'stepKey', 'contextPayload',
      ],
      additionalProperties: true,
      properties: {
        _id:            { bsonType: 'string' },
        projectId:      { bsonType: 'string' },
        runId:          { bsonType: 'string' },
        seq:            { bsonType: 'int' },
        ts:             { bsonType: 'date' },
        type: {
          bsonType: 'string',
          enum: ['run_start','context','step','tool_call','retrieval','output','run_end','error'],
        },
        status:         { bsonType: 'string', enum: ['ok','error','violation'] },
        stepKey:        { bsonType: 'string' },
        contextPayload: { bsonType: 'object' },
      },
    },
  },

  runs: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['runId', 'projectId', 'status', 'startedAt'],
      additionalProperties: true,
      properties: {
        runId:       { bsonType: 'string' },
        projectId:   { bsonType: 'string' },
        contextHash: { bsonType: 'string' },
        status:      { bsonType: 'string', enum: ['running','completed','failed'] },
        violations:  { bsonType: 'array' },
        startedAt:   { bsonType: 'date' },
        endedAt:     { bsonType: ['date', 'null'] },
        inputId:     { bsonType: 'string' },
      },
    },
  },

  contexts: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['contentHash', 'createdAt'],
      additionalProperties: true,
      properties: {
        contentHash: { bsonType: 'string' },
        model:       { bsonType: 'string' },
        promptText:  { bsonType: 'string' },
        config:      { bsonType: 'object' },
        toolSchemas: { bsonType: 'object' },
        deps:        { bsonType: 'object' },
        parentHash:  { bsonType: ['string', 'null'] },
        createdAt:   { bsonType: 'date' },
      },
    },
  },

  deployments: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['projectId'],
      additionalProperties: true,
      properties: {
        projectId:    { bsonType: 'string' },
        live:         { bsonType: 'string' },
        baselineHash: { bsonType: 'string' },
        history:      { bsonType: 'array' },
        rev:          { bsonType: ['int', 'double'] },
      },
    },
  },

  inputs:      { $jsonSchema: { bsonType: 'object', additionalProperties: true } },
  contracts:   { $jsonSchema: { bsonType: 'object', additionalProperties: true } },
  incidents:   { $jsonSchema: { bsonType: 'object', additionalProperties: true } },
  experiments: { $jsonSchema: { bsonType: 'object', additionalProperties: true } },
  jobs:        { $jsonSchema: { bsonType: 'object', additionalProperties: true } },
  meta:        { $jsonSchema: { bsonType: 'object', additionalProperties: true } },

  replayCache: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['key'],
      additionalProperties: true,
      properties: { key: { bsonType: 'string' } },
    },
  },

  lessons: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['symptom', 'culprit', 'fix', 'status', 'createdAt'],
      additionalProperties: true,
      properties: {
        incidentId: { bsonType: ['string', 'null'] },
        projectId: { bsonType: 'string' },
        symptom:   { bsonType: 'string' },
        culprit:   { bsonType: ['object', 'string'] },
        fix:       { bsonType: 'string' },
        embedding: { bsonType: 'array' },
        status:    { bsonType: 'string', enum: ['active','corrected','expired'] },
        expiresAt: { bsonType: ['date', 'null'] },
        createdAt: { bsonType: 'date' },
      },
    },
  },
};

// ─── Regular indexes ──────────────────────────────────────────────────────────

type IndexSpec = { collection: string; key: Document; options?: Document };

const indexes: IndexSpec[] = [
  { collection: 'events',      key: { projectId: 1, runId: 1, seq: 1 },             options: { name: 'events_project_run_seq' } },
  { collection: 'events',      key: { runId: 1, seq: 1 },                           options: { name: 'events_run_seq' } },
  { collection: 'events',      key: { projectId: 1, ts: -1 },                       options: { name: 'events_project_ts' } },
  { collection: 'runs',        key: { runId: 1 },                                    options: { unique: true, name: 'runs_runId_unique' } },
  { collection: 'runs',        key: { projectId: 1, contextHash: 1, startedAt: -1 }, options: { name: 'runs_project_hash_started' } },
  { collection: 'contexts',    key: { contentHash: 1 },                              options: { unique: true, name: 'contexts_hash_unique' } },
  { collection: 'deployments', key: { projectId: 1 },                               options: { unique: true, name: 'deployments_project_unique' } },
  { collection: 'replayCache', key: { key: 1 },                                     options: { unique: true, name: 'replay_key_unique' } },
  { collection: 'incidents',   key: { projectId: 1, badHash: 1 },                   options: { unique: true, partialFilterExpression: { status: 'open' }, name: 'incidents_open_unique' } },
  { collection: 'contracts',   key: { projectId: 1, tool: 1 },                      options: { unique: true, name: 'contracts_project_tool_unique' } },
  { collection: 'lessons',     key: { incidentId: 1 },                              options: { unique: true, sparse: true, name: 'lessons_incidentId_unique' } },
  { collection: 'lessons',     key: { projectId: 1, status: 1 },                    options: { name: 'lessons_project_status' } },
  // TTL: expireAfterSeconds:0 uses the expiresAt field value as the expiry moment
  { collection: 'lessons', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: 'lessons_ttl', sparse: true } },
];

// ─── Main export ─────────────────────────────────────────────────────────────

export async function initDb(db: Db): Promise<void> {
  const existing = await db
    .listCollections()
    .toArray()
    .then((cols) => new Set(cols.map((c) => c.name)));

  // 1. Collections — create or update validators
  for (const [name, validator] of Object.entries(validators)) {
    if (existing.has(name)) {
      await db.command({
        collMod: name,
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else {
      await db.createCollection(name, {
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    }
  }

  // 2. Regular indexes
  for (const spec of indexes) {
    await db.collection(spec.collection).createIndex(spec.key, spec.options ?? {});
  }

  // 3. Atlas Search / Vector Search indexes on lessons
  //    Best-effort: Atlas M0 is slow to build these; failure must not crash server.
  //    Atlas M0 limit: 3 total. We use 2: lessons_vector + lessons_text.
  const embedDim = parseInt(process.env['EMBED_DIM'] ?? '1024', 10);
  const lessonsCol = db.collection('lessons');

  try {
    const existingSearchIdxs = await lessonsCol
      .listSearchIndexes()
      .toArray()
      .catch(() => []);

    const existingNames = new Set(existingSearchIdxs.map((i: any) => i.name));
    const vectorIdx = existingSearchIdxs.find((i: any) => i.name === 'lessons_vector') as any;

    let needRecreateVector = !existingNames.has('lessons_vector');
    if (vectorIdx) {
      const vecField = vectorIdx.latestDefinition?.fields?.find((f: any) => f.type === 'vector');
      if (vecField && typeof vecField.numDimensions === 'number' && vecField.numDimensions !== embedDim) {
        console.log(`[Waypoint] Recreating lessons_vector: dimension changed from ${vecField.numDimensions} to ${embedDim}`);
        await lessonsCol.dropSearchIndex('lessons_vector').catch(() => undefined);
        needRecreateVector = true;
      }
    }

    const creates: Array<Promise<unknown>> = [];

    if (needRecreateVector) {
      creates.push(
        lessonsCol.createSearchIndex({
          name: 'lessons_vector',
          type: 'vectorSearch',
          definition: {
            fields: [
              { type: 'vector', path: 'embedding', numDimensions: embedDim, similarity: 'cosine' },
              { type: 'filter', path: 'projectId' },
              { type: 'filter', path: 'status' },
            ],
          },
        }),
      );
    }

    if (!existingNames.has('lessons_text')) {
      creates.push(
        lessonsCol.createSearchIndex({
          name: 'lessons_text',
          type: 'search',
          definition: {
            mappings: {
              dynamic: false,
              fields: {
                symptom: { type: 'string', analyzer: 'lucene.standard' },
                culprit: { type: 'string', analyzer: 'lucene.standard' },
                fix:     { type: 'string', analyzer: 'lucene.standard' },
              },
            },
          },
        }),
      );
    }

    if (creates.length > 0) {
      await Promise.all(creates);
      // Mark pending — Atlas builds indexes asynchronously; they become READY later.
      searchIndexStatus = 'pending';
      console.warn(
        '[Waypoint] Atlas search indexes submitted (building asynchronously). ' +
        'GET /health will report searchIndexes:"pending" until they are READY.',
      );
    } else {
      // Indexes already exist — check their status
      const allReady = existingSearchIdxs.every(
        (i: any) => i.status === 'READY',
      );
      searchIndexStatus = allReady ? 'ready' : 'pending';
    }

    // Re-embed any existing lessons that lack current vector dimensions
    await syncLessonEmbeddings(db).catch((err) => {
      console.warn('[Waypoint] Non-fatal: lesson re-embedding skipped or failed:', err);
    });
  } catch (err) {
    // Search index errors must not crash the server (common on Atlas M0 cold start)
    searchIndexStatus = 'failed';
    console.warn(
      '[Waypoint] WARNING: Atlas search index setup failed. ' +
      'Core functionality unaffected. Error:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
