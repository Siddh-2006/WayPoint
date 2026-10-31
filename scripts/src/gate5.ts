/**
 * scripts/src/gate5.ts — Gate 5: Content-Hashed Contexts & Derived Diff
 *
 * Checks:
 *   (a) Same context with keys in different order gives the same hash
 *   (b) Any one-character prompt change gives a different hash
 *   (c) Diff of planted change (model gpt-4 -> gpt-4o, prompt line edited, chunkSize 512 -> 256)
 *       returns exactly 3 changes with the right axes ('model', 'prompt', 'config')
 *   (d) 200 concurrent POSTs of one context create exactly 1 document, created:true once
 *   (e) Unknown hash returns 404; invalid body returns 422
 *   (f) Diff output order is identical across 10 runs
 *
 * Exits non-zero on failure.
 */

import { MongoClient } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';
import { hashContext, canonicalize } from '../../server/src/contexts/hash.js';
import { diffContexts } from '../../server/src/contexts/diff.js';

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
const contextsCol = client.db(dbName).collection('contexts');

async function postContext(body: unknown, apiKey = API_KEY): Promise<Response> {
  return fetch(`${BASE_URL}/v1/contexts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
}

console.log('\n─── Gate 5: Content-Hashed Contexts & Derived Diff ───\n');

// ─── (a) Same context with keys in different order gives same hash ───────────
try {
  const ctx1 = {
    model: 'gpt-4o',
    promptText: 'System prompt instructions',
    config: { temperature: 0.7, maxTokens: 1000 },
    toolSchemas: { toolA: { type: 'function' }, toolB: { type: 'action' } },
    deps: { lodash: '4.17.21', axios: '1.6.0' },
  };

  const ctx2 = {
    deps: { axios: '1.6.0', lodash: '4.17.21' },
    config: { maxTokens: 1000, temperature: 0.7 },
    toolSchemas: { toolB: { type: 'action' }, toolA: { type: 'function' } },
    promptText: 'System prompt instructions',
    model: 'gpt-4o',
  };

  const h1 = hashContext(ctx1);
  const h2 = hashContext(ctx2);
  const ok = h1 === h2 && h1.length === 64;
  check('(a) Key order independence → same hash', ok, `hash=${h1.slice(0, 12)}…`);
} catch (err) {
  check('(a) Key order independence', false, String(err));
}

// ─── (b) Single-character prompt change gives different hash ─────────────────
try {
  const base = {
    model: 'gpt-4o',
    promptText: 'Analyze this invoice carefully.',
    config: { temperature: 0 },
  };
  const modified = {
    ...base,
    promptText: 'Analyze this invoice carefully!', // 1 char difference
  };

  const hBase = hashContext(base);
  const hMod = hashContext(modified);
  const ok = hBase !== hMod;
  check('(b) Single-char prompt change → different hash', ok, `${hBase.slice(0, 8)}… != ${hMod.slice(0, 8)}…`);
} catch (err) {
  check('(b) Single-char prompt change', false, String(err));
}

// ─── (c) Diff of planted change returns exactly 3 changes with right axes ────
try {
  const ctxA = {
    model: 'gpt-4',
    promptText: 'You are an invoice parser.\nAlways extract dates.\nReturn JSON.',
    config: { chunkSize: 512, debug: false },
    toolSchemas: {},
    deps: {},
  };

  const ctxB = {
    model: 'gpt-4o',
    promptText: 'You are an invoice parser.\nAlways extract dates strictly.\nReturn JSON.',
    config: { chunkSize: 256, debug: false },
    toolSchemas: {},
    deps: {},
  };

  const changes = diffContexts(ctxA, ctxB);
  const axes = changes.map((c) => c.axis);
  const ok =
    changes.length === 3 &&
    axes[0] === 'model' &&
    axes[1] === 'prompt' &&
    axes[2] === 'config' &&
    changes[0]?.path === 'model' &&
    changes[1]?.path === 'promptText' &&
    changes[2]?.path === 'chunkSize';

  check(
    '(c) Planted change diff → exactly 3 changes with right axes',
    ok,
    `count=${changes.length} axes=[${axes.join(', ')}]`,
  );
} catch (err) {
  check('(c) Planted change diff', false, String(err));
}

// ─── (d) 200 concurrent POSTs create exactly 1 document, created:true once ───
try {
  const uniqueMarker = Date.now();
  const testCtx = {
    projectId: `gate5-proj-${uniqueMarker}`,
    model: `gate5-model-${uniqueMarker}`,
    promptText: `Prompt test for concurrency ${uniqueMarker}`,
    config: { worker: 4, batchSize: 50 },
  };

  const expectedHash = hashContext(testCtx);

  // Send 200 requests concurrently
  const responses = await Promise.all(
    Array.from({ length: 200 }, () => postContext(testCtx)),
  );

  const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
    hash: string;
    created: boolean;
  }>;

  const createdCount = bodies.filter((b) => b.created === true).length;
  const ignoredCount = bodies.filter((b) => b.created === false).length;
  const dbCount = await contextsCol.countDocuments({ contentHash: expectedHash });

  const ok = dbCount === 1 && createdCount === 1 && ignoredCount === 199;
  check(
    '(d) 200 concurrent POSTs → 1 doc in DB, created:true exactly once',
    ok,
    `dbCount=${dbCount} created=${createdCount} duplicate_success=${ignoredCount}`,
  );
} catch (err) {
  check('(d) 200 concurrent POSTs', false, String(err));
}

// ─── (e) Unknown hash returns 404; invalid body returns 422 ──────────────────
try {
  // 1. Unknown hash
  const res404 = await fetch(`${BASE_URL}/v1/contexts/nonexistent_hash_1234567890abcdef`);
  const is404 = res404.status === 404;

  // 2. Invalid body (missing model)
  const res422 = await postContext({
    promptText: 'missing model',
  });
  const is422 = res422.status === 422;

  check(
    '(e) Unknown hash → 404, invalid body → 422',
    is404 && is422,
    `unknownHash=${res404.status} invalidBody=${res422.status}`,
  );
} catch (err) {
  check('(e) Unknown hash / invalid body', false, String(err));
}

// ─── (f) Diff output order is identical across 10 runs ────────────────────────
try {
  const ctxA = {
    model: 'model-a',
    promptText: 'Original instructions\nline two\nline three',
    config: { zParam: 100, aParam: 200, mParam: { childZ: 1, childA: 2 } },
    toolSchemas: { toolZ: { a: 1 }, toolA: { b: 2 } },
    deps: { zDep: '1.0', aDep: '2.0' },
  };

  const ctxB = {
    model: 'model-b',
    promptText: 'New instructions\nline two modified\nline three',
    config: { zParam: 101, aParam: 201, mParam: { childZ: 3, childA: 4 } },
    toolSchemas: { toolZ: { a: 2 }, toolA: { b: 3 } },
    deps: { zDep: '1.1', aDep: '2.1' },
  };

  const snapshots: string[] = [];
  for (let i = 0; i < 10; i++) {
    snapshots.push(JSON.stringify(diffContexts(ctxA, ctxB)));
  }

  const allIdentical = snapshots.every((s) => s === snapshots[0]);
  check(
    '(f) Diff output order identical across 10 runs',
    allIdentical,
    `all 10 runs match byte-for-byte`,
  );
} catch (err) {
  check('(f) Diff output order identical', false, String(err));
}

await client.close();

console.log(`\n${allPassed ? '✅ Gate 5 PASSED' : '❌ Gate 5 FAILED'}`);
process.exit(allPassed ? 0 : 1);
