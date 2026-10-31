/**
 * scripts/src/gate2.ts — Gate 2: DB Initialization
 *
 * Checks (after running initDb() twice):
 *   (1) A valid event inserts successfully
 *   (2) A duplicate _id fails with code 11000
 *   (3) An event missing `ts` fails validation (code 121)
 *   (4a) contextPayload accepts a string-only payload { note: "hello" }
 *   (4b) contextPayload accepts a deeply nested object
 *
 * Exits non-zero if any check fails.
 */

import { MongoClient, MongoServerError } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';
import { initDb } from '../../server/src/db/init.js';

loadEnv();

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';
let allPassed = true;

function check(label: string, passed: boolean, detail?: string): void {
  console.log(`${passed ? PASS : FAIL}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!passed) allPassed = false;
}

const uri = requireEnv('MONGODB_URI');
const dbName = requireEnv('MONGODB_DB');
const client = new MongoClient(uri);

try {
  await client.connect();
  const db = client.db(dbName);

  // ── Run init twice to verify idempotency ────────────────────────────────────
  console.log('\nRunning initDb() — pass 1…');
  await initDb(db);
  console.log('Running initDb() — pass 2 (must be silent / no errors)…');
  await initDb(db);
  console.log('Both passes complete.\n');

  const col = db.collection('events');
  const baseEvent = {
    _id: `gate2-evt-${Date.now()}`,
    projectId: 'gate2-proj',
    runId: `gate2-run-${Date.now()}`,
    seq: 1,
    ts: new Date(),
    type: 'step',
    status: 'ok',
    stepKey: 'test-step',
    contextPayload: { note: 'hello' },
    insertedAt: new Date(),
  };

  // ── (1) Valid event inserts ──────────────────────────────────────────────────
  try {
    const r = await col.insertOne({ ...baseEvent });
    check('(1) Valid event inserts', r.acknowledged, `insertedId=${String(r.insertedId)}`);
  } catch (err) {
    check('(1) Valid event inserts', false, String(err));
  }

  // ── (2) Duplicate _id → code 11000 ──────────────────────────────────────────
  try {
    await col.insertOne({ ...baseEvent }); // same _id
    check('(2) Duplicate _id → 11000', false, 'no error thrown — expected duplicate key');
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      check('(2) Duplicate _id → 11000', true, `code=${err.code}`);
    } else {
      check('(2) Duplicate _id → 11000', false, `wrong error: ${String(err)}`);
    }
  }

  // ── (3) Missing `ts` → code 121 ─────────────────────────────────────────────
  try {
    const { ts: _ts, ...noTs } = baseEvent;
    await col.insertOne({ ...noTs, _id: `gate2-no-ts-${Date.now()}` } as never);
    check('(3) Missing ts → 121', false, 'no error thrown — expected validation error');
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 121) {
      check('(3) Missing ts → 121', true, `code=${err.code}`);
    } else {
      check('(3) Missing ts → 121', false, `wrong error: ${String(err)}`);
    }
  }

  // ── (4a) contextPayload: string-only flat object ─────────────────────────────
  try {
    const r = await col.insertOne({
      ...baseEvent,
      _id: `gate2-ctx-str-${Date.now()}`,
      contextPayload: { note: 'string only value' },
    });
    check('(4a) contextPayload string-only', r.acknowledged);
  } catch (err) {
    check('(4a) contextPayload string-only', false, String(err));
  }

  // ── (4b) contextPayload: deeply nested object ────────────────────────────────
  try {
    const r = await col.insertOne({
      ...baseEvent,
      _id: `gate2-ctx-deep-${Date.now()}`,
      contextPayload: {
        level1: { level2: { level3: { level4: { value: 42, flag: true } } } },
        arr: [1, 'two', { three: 3 }],
      },
    });
    check('(4b) contextPayload deeply nested', r.acknowledged);
  } catch (err) {
    check('(4b) contextPayload deeply nested', false, String(err));
  }

} finally {
  await client.close();
}

console.log(`\n${allPassed ? '✅ Gate 2 PASSED' : '❌ Gate 2 FAILED'}`);
process.exit(allPassed ? 0 : 1);
