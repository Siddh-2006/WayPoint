/**
 * scripts/src/gate-atlas-m0.ts
 *
 * Runs Atlas M0 verification suite:
 *   - Enforces strict target database check (waypoint_atlas_test only; hard refuse on waypoint_prod / waypoint_local)
 *   - Documents M0 operational constraints (connections <= 500, ~100 ops/sec, 512MB RAM/disk, singleton change stream)
 *   - Runs gates 2, 3 (reduced concurrency 50), 5, 6, 7, 9, 10, 11h, 12 against MongoDB Atlas M0
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// 1. Read .env.atlas
const atlasEnvPath = resolve(ROOT, '.env.atlas');
if (!existsSync(atlasEnvPath)) {
  console.error('❌ .env.atlas does not exist at root');
  process.exit(1);
}

const rawEnv = readFileSync(atlasEnvPath, 'utf-8');
const atlasEnv: Record<string, string> = { ...process.env as Record<string, string> };
for (const line of rawEnv.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx !== -1) {
    const k = trimmed.slice(0, eqIdx).trim();
    const v = trimmed.slice(eqIdx + 1).trim();
    atlasEnv[k] = v;
  }
}

const dbName = atlasEnv['MONGODB_DB'];
const uri = atlasEnv['MONGODB_URI'];

console.log('========================================================================');
console.log(' 🌐 MONGODB ATLAS M0 VERIFICATION & CONCURRENCY BENCHMARK');
console.log('========================================================================\n');

// 2. Strict Safety Guard
if (dbName === 'waypoint_prod' || dbName === 'waypoint_local') {
  console.error(`❌ FATAL REFUSAL: MONGODB_DB="${dbName}".`);
  console.error('   Running test suites against waypoint_prod or waypoint_local is strictly forbidden!');
  console.error('   Please set MONGODB_DB=waypoint_atlas_test in .env.atlas.\n');
  process.exit(1);
}

if (dbName !== 'waypoint_atlas_test') {
  console.error(`❌ FATAL REFUSAL: Target database must be "waypoint_atlas_test", received "${dbName}".\n`);
  process.exit(1);
}

if (!uri || !uri.includes('mongodb+srv://')) {
  console.error('❌ FATAL REFUSAL: MONGODB_URI in .env.atlas must be a valid Atlas SRV connection string.\n');
  process.exit(1);
}

console.log(`[Safety Guard] Passed: verified target database is "${dbName}".`);
console.log('[Safety Guard] Verified SRV connection to Atlas cluster.\n');

// 3. Document Atlas M0 Limitations
console.log('------------------------------------------------------------------------');
console.log(' ATLAS M0 OPERATIONAL CONSTRAINTS');
console.log('------------------------------------------------------------------------');
console.log(' • Concurrent Connections : 500 max (Atlas M0 hard cap).');
console.log(' • Operations / Throughput: ~100 ops/sec burstable; sustained high-IO throttled.');
console.log(' • Storage / Memory       : 512 MB disk storage, shared RAM / CPU.');
console.log(' • Change Streams         : Supported (3-node replica set). Waypoint uses singleton');
console.log('                            change stream with in-memory fan-out (D30) to prevent');
console.log('                            connection and cursor exhaustion on M0.');
console.log(' • Network Latency        : ~50-150ms round-trip over Internet vs <1ms local.');
console.log(' • Gate 3 Concurrency     : Tuned to GATE3_CONCURRENCY=50 to stay within M0 IOPS.\n');

interface GateDef {
  id: string;
  script: string;
  envOverrides?: Record<string, string>;
}

const ATLAS_GATES: GateDef[] = [
  { id: 'gate:2', script: 'scripts/src/gate2.ts' },
  { id: 'gate:3', script: 'scripts/src/gate3.ts', envOverrides: { GATE3_CONCURRENCY: '50' } },
  { id: 'gate:5', script: 'scripts/src/gate5.ts' },
  { id: 'gate:6', script: 'scripts/src/gate6.ts' },
  { id: 'gate:7', script: 'scripts/src/gate7.ts' },
  { id: 'gate:9', script: 'scripts/src/gate9.ts' },
  { id: 'gate:10', script: 'scripts/src/gate10.ts' },
  { id: 'gate:11h', script: 'scripts/src/gate11h.ts' },
  { id: 'gate:12', script: 'scripts/src/gate12.ts' },
];

async function runCommand(script: string, customEnv: Record<string, string>): Promise<{ code: number; duration: number; error?: string }> {
  const t0 = Date.now();
  return new Promise((res) => {
    const proc = spawn('pnpm', ['exec', 'tsx', script], {
      cwd: ROOT,
      shell: true,
      env: { ...atlasEnv, ...customEnv },
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      res({ code: code ?? 1, duration: (Date.now() - t0) / 1000, error: stderr.slice(-300) });
    });
  });
}

// 4. Test Connectivity to Atlas M0 & Start Port 3001 Server
let serverProc: any = null;
try {
  console.log('[Atlas M0] Testing connection to Atlas cluster...');
  const testClient = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await testClient.connect();
  const pingRes = await testClient.db('admin').command({ ping: 1 });
  console.log(`[Atlas M0] Connected successfully! Ping: ${JSON.stringify(pingRes)}\n`);
  await testClient.close();

  // Start Fastify server instance pointing to Atlas on port 3001
  console.log('[Atlas M0] Starting dedicated Fastify instance on port 3001 pointing to Atlas M0...');
  atlasEnv['PORT'] = '3001';
  atlasEnv['BASE_URL'] = 'http://localhost:3001';
  atlasEnv['PUBLIC_URL'] = 'http://localhost:3001';
  atlasEnv['GATE3_CONCURRENCY'] = '50';

  serverProc = spawn('pnpm', ['exec', 'tsx', 'server/src/index.ts'], {
    cwd: ROOT,
    shell: true,
    env: { ...atlasEnv },
  });

  // Wait for port 3001 /health to be ready
  let serverReady = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const hRes = await fetch('http://localhost:3001/health');
      if (hRes.ok) {
        const body = await hRes.json() as { ok: boolean; mongo: string };
        if (body.ok && body.mongo === 'up') {
          serverReady = true;
          break;
        }
      }
    } catch {
      // still starting
    }
  }

  if (!serverReady) {
    throw new Error('Port 3001 Atlas server failed to start or mongo health was not up within 30s');
  }
  console.log('[Atlas M0] Dedicated Atlas server is UP on port 3001 with mongo: up.\n');
} catch (err: any) {
  console.error('❌ Failed during Atlas M0 setup:', err?.message || err);
  if (serverProc) serverProc.kill();
  process.exit(1);
}

// 5. Execute Gates against Atlas M0
const results: Array<{ id: string; status: 'PASS' | 'FAIL'; duration: string; error?: string }> = [];
let allPassed = true;

for (const g of ATLAS_GATES) {
  process.stdout.write(`[...] Running ${g.id.padEnd(10)} against Atlas M0 (${g.script})... `);
  const out = await runCommand(g.script, g.envOverrides ?? {});
  const durStr = `${out.duration.toFixed(1)}s`;
  if (out.code === 0) {
    console.log(`PASS (${durStr})`);
    results.push({ id: g.id, status: 'PASS', duration: durStr });
  } else {
    console.log(`FAIL (${durStr})`);
    results.push({ id: g.id, status: 'FAIL', duration: durStr, error: out.error });
    allPassed = false;
  }
}

// 6. Print Summary Table
console.log('\n========================================================================');
console.log(' ATLAS M0 GATE SUITE SUMMARY TABLE');
console.log(' Target Database: waypoint_atlas_test');
console.log('========================================================================');
console.log('| Gate       | Status    | Duration | Notes                                  |');
console.log('|------------|-----------|----------|----------------------------------------|');
for (const r of results) {
  const idStr = r.id.padEnd(10);
  const stStr = r.status.padEnd(9);
  const durStr = r.duration.padEnd(8);
  const noteStr = r.error ? 'Failed' : 'Atlas verified';
  console.log(`| ${idStr} | ${stStr} | ${durStr} | ${noteStr.padEnd(38)} |`);
}
console.log('========================================================================\n');

if (serverProc) {
  try { serverProc.kill(); } catch {}
}

if (allPassed) {
  console.log('🎉 ALL ATLAS M0 GATES PASSED! Confirmed operational on MongoDB Atlas M0 cluster.');
  process.exit(0);
} else {
  console.error('❌ One or more gates failed on Atlas M0.');
  process.exit(1);
}
