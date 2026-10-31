/**
 * scripts/src/gate1.ts — Gate 1: Scaffold & Connectivity
 *
 * Checks:
 *   (a) MongoDB ping succeeds
 *   (b) Server is a replica set member (rs.status())
 *   (c) Change stream opens and receives an inserted document
 *   (d) Vector search index can be created and becomes queryable within 90 s
 *   (e) GET /health returns { ok: true }
 *
 * Cleans up temp collections. Exits non-zero if any check fails.
 */

import { MongoClient, ObjectId } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';

loadEnv();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';
let allPassed = true;

function result(label: string, passed: boolean, detail?: string): void {
  const icon = passed ? PASS : FAIL;
  console.log(`${icon}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!passed) allPassed = false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const uri = requireEnv('MONGODB_URI');
const dbName = requireEnv('MONGODB_DB');
const port = process.env['PORT'] ?? '3000';
const baseUrl = `http://localhost:${port}`;

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
const TEMP = `_gate1_${Date.now()}`;
const TEMP_VEC = `${TEMP}_vec`;

try {
  await client.connect();
  const db = client.db(dbName);
  const adminDb = client.db('admin');

  // ── (a) Ping ────────────────────────────────────────────────────────────────
  try {
    const ping = await adminDb.command({ ping: 1 });
    result('(a) Mongo ping', ping.ok === 1, JSON.stringify(ping));
  } catch (err) {
    result('(a) Mongo ping', false, String(err));
  }

  // ── (b) Replica set membership ──────────────────────────────────────────────
  try {
    const rs = await adminDb.command({ replSetGetStatus: 1 });
    const ok = rs.ok === 1 && Array.isArray(rs.members) && rs.members.length > 0;
    result('(b) Replica set status', ok, `set="${rs.set as string}" members=${(rs.members as unknown[]).length}`);
  } catch (err) {
    result('(b) Replica set status', false, String(err));
  }

  // ── (c) Change stream ────────────────────────────────────────────────────────
  const tempCol = db.collection(TEMP);
  try {
    const stream = tempCol.watch([], { fullDocument: 'updateLookup' });
    const received = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        void stream.close();
        resolve(false);
      }, 10_000);
      stream.once('change', () => {
        clearTimeout(timer);
        void stream.close();
        resolve(true);
      });
    });
    // Insert after a tick so the watch is established
    await new Promise((r) => setTimeout(r, 200));
    await tempCol.insertOne({ _id: new ObjectId(), test: true });
    const got = await received;
    result('(c) Change stream', got, got ? 'event received' : 'timed out after 10 s');
  } catch (err) {
    result('(c) Change stream', false, String(err));
  }

  // ── (d) Vector search index ──────────────────────────────────────────────────
  const vecCol = db.collection(TEMP_VEC);
  const INDEX_NAME = 'gate1_vec_test';
  try {
    // Seed a document with the vector field BEFORE creating the index,
    // so the index has data to scan and $vectorSearch returns results.
    await vecCol.insertOne({ v: [0.1, 0.2, 0.3, 0.4] });

    await vecCol.createSearchIndex({
      name: INDEX_NAME,
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'v', numDimensions: 4, similarity: 'cosine' },
        ],
      },
    });

    // Poll until READY or 90 s timeout
    const deadline = Date.now() + 90_000;
    let ready = false;
    let lastStatus = 'unknown';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        const idxes = await vecCol.listSearchIndexes(INDEX_NAME).toArray();
        lastStatus = (idxes[0] as { status?: string } | undefined)?.status ?? 'missing';
        if (lastStatus === 'READY') {
          ready = true;
          break;
        }
      } catch {
        // listSearchIndexes may fail transiently; keep polling
      }
    }

    if (ready) {
      // Verify it's actually queryable with a $vectorSearch pipeline
      // (the seed doc was inserted before indexing, so the index covers it)
      const agg = await vecCol
        .aggregate([
          {
            $vectorSearch: {
              index: INDEX_NAME,
              queryVector: [0.1, 0.2, 0.3, 0.4],
              path: 'v',
              numCandidates: 10,
              limit: 1,
            },
          },
        ])
        .toArray();
      result('(d) Vector search index', agg.length === 1, `status=READY, results=${agg.length}`);
    } else {
      result('(d) Vector search index', false, `status=${lastStatus} after 90 s`);
    }
  } catch (err) {
    result('(d) Vector search index', false, String(err));
  }

  // ── (e) GET /health ──────────────────────────────────────────────────────────
  try {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as { ok?: boolean; mongo?: string };
    const ok = res.status === 200 && body.ok === true && body.mongo === 'up';
    result('(e) GET /health', ok, JSON.stringify(body));
  } catch (err) {
    result('(e) GET /health', false, String(err));
  }

} finally {
  // Cleanup
  try {
    const db = client.db(dbName);
    await db.collection(TEMP).drop().catch(() => undefined);
    await db.collection(TEMP_VEC).drop().catch(() => undefined);
  } catch { /* best-effort */ }
  await client.close();
}

console.log(`\n${allPassed ? '✅ Gate 1 PASSED' : '❌ Gate 1 FAILED'}`);
process.exit(allPassed ? 0 : 1);
