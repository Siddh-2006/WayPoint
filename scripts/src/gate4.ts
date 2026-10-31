/**
 * scripts/src/gate4.ts — Gate 4: Production deploy against Atlas M0
 *
 * Reads from environment:
 *   BASE_URL  — public URL of the deployed server (e.g. https://waypoint.up.railway.app)
 *   API_KEY   — one of the production API_KEYS
 *   MONGODB_URI — Atlas M0 connection string (for the change-stream check)
 *   MONGODB_DB  — production database name
 *
 * Checks:
 *   (a) GET /health → { ok: true, mongo: "up" }
 *   (b) POST /v1/events with a unique eventId → inserted
 *   (c) Same POST again → duplicate_ignored
 *   (d) POST without x-api-key → 401
 *   (e) POST missing required field → 422
 *   (f) GET /v1/runs/:runId/events returns the event in order
 *   (g) Change stream on Atlas receives an inserted document
 *
 * Deletes test docs before exiting (best-effort).
 * Exits non-zero on any failure.
 */

import { MongoClient } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';

loadEnv();

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';
let allPassed = true;

function check(label: string, passed: boolean, detail?: string): void {
  console.log(`${passed ? PASS : FAIL}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!passed) allPassed = false;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = requireEnv('BASE_URL').replace(/\/$/, '');
const API_KEY  = requireEnv('API_KEY');
const MONGODB_URI = requireEnv('MONGODB_URI');
const MONGODB_DB  = requireEnv('MONGODB_DB');

const TS = new Date().toISOString();
const RUN_ID = `gate4-run-${Date.now()}`;

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ─── (a) GET /health ─────────────────────────────────────────────────────────
console.log(`\nTarget: ${BASE_URL}\n`);

try {
  const res = await fetch(`${BASE_URL}/health`);
  const body = (await res.json()) as { ok?: boolean; mongo?: string; searchIndexes?: string };
  const ok = res.status === 200 && body.ok === true && body.mongo === 'up';
  check(
    '(a) GET /health → ok + mongo up',
    ok,
    `HTTP ${res.status} ok=${String(body.ok)} mongo=${body.mongo ?? '?'} searchIndexes=${body.searchIndexes ?? '?'}`,
  );
} catch (err) {
  check('(a) GET /health → ok + mongo up', false, String(err));
}

// ─── (b) POST event → inserted ────────────────────────────────────────────────
const EVENT_ID = `gate4-evt-${Date.now()}`;
const validEvent = {
  eventId: EVENT_ID,
  projectId: 'gate4',
  runId: RUN_ID,
  seq: 0,
  ts: TS,
  type: 'step',
  status: 'ok',
  stepKey: 'gate4-check',
  contextPayload: { note: 'gate4 probe' },
};

try {
  const res = await post(validEvent, { 'x-api-key': API_KEY });
  const body = (await res.json()) as { results?: Array<{ status: string }> };
  const ok = res.status === 201 && body.results?.[0]?.status === 'inserted';
  check('(b) POST → inserted', ok, `HTTP ${res.status} status=${body.results?.[0]?.status}`);
} catch (err) {
  check('(b) POST → inserted', false, String(err));
}

// ─── (c) Same POST again → duplicate_ignored ──────────────────────────────────
try {
  const res = await post(validEvent, { 'x-api-key': API_KEY });
  const body = (await res.json()) as { results?: Array<{ status: string }> };
  const ok = body.results?.[0]?.status === 'duplicate_ignored';
  check('(c) Same POST → duplicate_ignored', ok, `status=${body.results?.[0]?.status}`);
} catch (err) {
  check('(c) Same POST → duplicate_ignored', false, String(err));
}

// ─── (d) No x-api-key → 401 ──────────────────────────────────────────────────
try {
  const res = await post(validEvent);
  check('(d) No x-api-key → 401', res.status === 401, `HTTP ${res.status}`);
} catch (err) {
  check('(d) No x-api-key → 401', false, String(err));
}

// ─── (e) Missing field → 422 ──────────────────────────────────────────────────
try {
  // Missing ts, type, status, stepKey, contextPayload
  const res = await post(
    { eventId: `gate4-bad-${Date.now()}`, projectId: 'gate4', runId: RUN_ID, seq: 0 },
    { 'x-api-key': API_KEY },
  );
  check('(e) Missing field → 422', res.status === 422, `HTTP ${res.status}`);
} catch (err) {
  check('(e) Missing field → 422', false, String(err));
}

// ─── (f) GET /v1/runs/:runId/events returns event ─────────────────────────────
try {
  const res = await fetch(`${BASE_URL}/v1/runs/${RUN_ID}/events`, {
    headers: { 'x-api-key': API_KEY },
  });
  const body = (await res.json()) as { events?: Array<{ stepKey: string; seq: number }> };
  const events = body.events ?? [];
  const found = events.some((e) => e.stepKey === 'gate4-check');
  check(
    '(f) GET /v1/runs/:runId/events returns event',
    res.status === 200 && found,
    `HTTP ${res.status} count=${events.length} found=${String(found)}`,
  );
} catch (err) {
  check('(f) GET /v1/runs/:runId/events', false, String(err));
}

// ─── (g) Change stream on Atlas receives an insert ────────────────────────────
const CHANGE_STREAM_TIMEOUT_MS = 15_000;
const csClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
const CS_COLLECTION = `_gate4_cs_${Date.now()}`;

try {
  await csClient.connect();
  const db = csClient.db(MONGODB_DB);
  const col = db.collection(CS_COLLECTION);

  // Seed the collection so it exists (change streams need an existing collection)
  await col.insertOne({ _init: true });

  const stream = col.watch([], { fullDocument: 'updateLookup' });

  const received = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      void stream.close();
      resolve(false);
    }, CHANGE_STREAM_TIMEOUT_MS);

    stream.once('change', (ev) => {
      if ((ev as { operationType?: string }).operationType === 'insert') {
        clearTimeout(timer);
        void stream.close();
        resolve(true);
      }
    });
  });

  // Give the watch a moment to establish before inserting
  await new Promise((r) => setTimeout(r, 500));
  await col.insertOne({ probe: 'gate4', ts: new Date() });

  const got = await received;
  check(
    '(g) Atlas change stream receives insert',
    got,
    got ? 'event received within 15 s' : 'timed out after 15 s',
  );
} catch (err) {
  check('(g) Atlas change stream', false, String(err));
} finally {
  // Clean up — drop temp collection
  try {
    await csClient.db(MONGODB_DB).collection(CS_COLLECTION).drop();
  } catch { /* best-effort */ }
  await csClient.close();
}

// ─── Clean up test events ─────────────────────────────────────────────────────
// (best-effort via direct Atlas connection so we don't pollute the DB)
try {
  const cleanClient = new MongoClient(MONGODB_URI);
  await cleanClient.connect();
  await cleanClient.db(MONGODB_DB).collection('events').deleteMany({ projectId: 'gate4' });
  await cleanClient.close();
  console.log('\n[gate4] Test events cleaned up.');
} catch {
  console.warn('[gate4] Cleanup of test events failed (non-fatal).');
}

console.log(`\n${allPassed ? '✅ Gate 4 PASSED' : '❌ Gate 4 FAILED'}`);
process.exit(allPassed ? 0 : 1);

