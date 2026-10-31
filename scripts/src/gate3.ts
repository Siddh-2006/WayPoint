/**
 * scripts/src/gate3.ts — Gate 3: Ingest API
 *
 * Checks (server must be running; set BASE_URL or PORT):
 *   (1) Valid event → { status: "inserted" }
 *   (2) Same eventId sent 1,000 times concurrently → exactly 1 stored document
 *   (3) Missing required field → 422, nothing stored
 *   (4) Payload with api_key:"sk-test123" is stored as "[REDACTED]"
 *   (5) Request without x-api-key → 401
 *   (6) Events inserted with seq 3,1,2 are returned in order 1,2,3
 *
 * Exits non-zero if any check fails.
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

const port = process.env['PORT'] ?? '3000';
const BASE_URL = process.env['BASE_URL'] ?? `http://localhost:${port}`;
const API_KEY = requireEnv('API_KEYS').split(',')[0]!.trim();
const uri = requireEnv('MONGODB_URI');
const dbName = requireEnv('MONGODB_DB');

const client = new MongoClient(uri);
await client.connect();
const col = client.db(dbName).collection('events');

const TS = new Date().toISOString();

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ── (1) Valid event → inserted ────────────────────────────────────────────────
try {
  const eventId = `gate3-v1-${Date.now()}`;
  const res = await post(
    {
      eventId,
      projectId: 'gate3',
      runId: 'gate3-run-1',
      seq: 0,
      ts: TS,
      type: 'step',
      status: 'ok',
      stepKey: 'test',
      contextPayload: { note: 'hello' },
    },
    { 'x-api-key': API_KEY },
  );
  const body = (await res.json()) as { results?: Array<{ status: string }> };
  const ok = res.status === 201 && body.results?.[0]?.status === 'inserted';
  check('(1) Valid event → inserted', ok, `HTTP ${res.status} status=${body.results?.[0]?.status}`);
} catch (err) {
  check('(1) Valid event → inserted', false, String(err));
}

// ── (2) 1,000 concurrent duplicates → exactly 1 stored doc ───────────────────
try {
  const eventId = `gate3-dup-${Date.now()}`;
  const event = {
    eventId,
    projectId: 'gate3',
    runId: 'gate3-run-dup',
    seq: 0,
    ts: TS,
    type: 'step',
    status: 'ok',
    stepKey: 'dup-test',
    contextPayload: {},
  };
  const responses = await Promise.all(
    Array.from({ length: 1000 }, () =>
      post(event, { 'x-api-key': API_KEY }),
    ),
  );
  const count = await col.countDocuments({ _id: eventId });
  const statuses = await Promise.all(responses.map((r) => r.json())) as Array<{ results?: Array<{ status: string }> }>;
  const insertedCount = statuses.filter((s) => s.results?.[0]?.status === 'inserted').length;
  const dupCount = statuses.filter((s) => s.results?.[0]?.status === 'duplicate_ignored').length;
  const ok = count === 1 && insertedCount === 1 && dupCount === 999;
  check(
    '(2) 1,000 concurrent duplicates → 1 doc',
    ok,
    `stored=${count} inserted=${insertedCount} dup_ignored=${dupCount}`,
  );
} catch (err) {
  check('(2) 1,000 concurrent duplicates → 1 doc', false, String(err));
}

// ── (3) Missing field → 422, nothing stored ───────────────────────────────────
try {
  const eventId = `gate3-bad-${Date.now()}`;
  const res = await post(
    // Missing: ts, type, status, stepKey, contextPayload
    { eventId, projectId: 'gate3', runId: 'x', seq: 0 },
    { 'x-api-key': API_KEY },
  );
  const count = await col.countDocuments({ _id: eventId });
  const ok = res.status === 422 && count === 0;
  check('(3) Missing field → 422, nothing stored', ok, `HTTP ${res.status} stored=${count}`);
} catch (err) {
  check('(3) Missing field → 422, nothing stored', false, String(err));
}

// ── (4) api_key in payload → stored as [REDACTED] ────────────────────────────
try {
  const eventId = `gate3-redact-${Date.now()}`;
  const res = await post(
    {
      eventId,
      projectId: 'gate3',
      runId: 'gate3-run-redact',
      seq: 0,
      ts: TS,
      type: 'step',
      status: 'ok',
      stepKey: 'redact-test',
      contextPayload: { api_key: 'sk-test123', model: 'gpt-4' },
    },
    { 'x-api-key': API_KEY },
  );
  const doc = await col.findOne({ _id: eventId });
  const payload = doc?.contextPayload as Record<string, unknown> | undefined;
  const ok =
    res.status === 201 &&
    payload?.['api_key'] === '[REDACTED]' &&
    payload?.['model'] === 'gpt-4';
  check('(4) api_key redacted in DB', ok, `api_key="${String(payload?.['api_key'])}" model="${String(payload?.['model'])}"`);
} catch (err) {
  check('(4) api_key redacted in DB', false, String(err));
}

// ── (5) No x-api-key → 401 ───────────────────────────────────────────────────
try {
  const res = await post(
    { eventId: 'x', projectId: 'g', runId: 'r', seq: 0, ts: TS, type: 'step', status: 'ok', stepKey: 's', contextPayload: {} },
    // no auth header
  );
  check('(5) No x-api-key → 401', res.status === 401, `HTTP ${res.status}`);
} catch (err) {
  check('(5) No x-api-key → 401', false, String(err));
}

// ── (6) Out-of-order insert → returned sorted by seq ─────────────────────────
try {
  const runId = `gate3-order-${Date.now()}`;
  const base = { projectId: 'gate3', runId, ts: TS, type: 'step', status: 'ok', stepKey: 'order-test', contextPayload: {} };

  await post({ ...base, eventId: `${runId}-seq3`, seq: 3 }, { 'x-api-key': API_KEY });
  await post({ ...base, eventId: `${runId}-seq1`, seq: 1 }, { 'x-api-key': API_KEY });
  await post({ ...base, eventId: `${runId}-seq2`, seq: 2 }, { 'x-api-key': API_KEY });

  const res = await fetch(`${BASE_URL}/v1/runs/${runId}/events`, {
    headers: { 'x-api-key': API_KEY },
  });
  const body = (await res.json()) as { events?: Array<{ seq: number }> };
  const seqs = body.events?.map((e) => e.seq) ?? [];
  const ok = JSON.stringify(seqs) === '[1,2,3]';
  check('(6) Seq ordering 3,1,2 → 1,2,3', ok, `returned=${JSON.stringify(seqs)}`);
} catch (err) {
  check('(6) Seq ordering 3,1,2 → 1,2,3', false, String(err));
}

await client.close();

console.log(`\n${allPassed ? '✅ Gate 3 PASSED' : '❌ Gate 3 FAILED'}`);
process.exit(allPassed ? 0 : 1);
