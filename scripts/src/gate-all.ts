/**
 * scripts/src/gate-all.ts
 *
 * Runs all validation gates in order:
 *   gates 2, 3, 5, 6, 7, 8, 9, 10, 10b, 11d, 11e, 11f, 11g, 11h, 12
 *
 * Supports --skip-network:
 *   Skips Voyage- and Ollama-dependent gates (10, 10b, 11d, 11e, 11f, 11g, 11h, 12),
 *   reporting them honestly as SKIPPED (never PASS).
 *
 * Exits 0 only if all executed gates pass.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

interface GateDef {
  id: string;
  script: string;
  network: boolean;
}

const GATES: GateDef[] = [
  { id: 'gate:2', script: 'scripts/src/gate2.ts', network: false },
  { id: 'gate:3', script: 'scripts/src/gate3.ts', network: false },
  { id: 'gate:5', script: 'scripts/src/gate5.ts', network: false },
  { id: 'gate:6', script: 'scripts/src/gate6.ts', network: false },
  { id: 'gate:7', script: 'scripts/src/gate7.ts', network: false },
  { id: 'gate:8', script: 'scripts/src/gate8.ts', network: false },
  { id: 'gate:9', script: 'scripts/src/gate9.ts', network: false },
  { id: 'gate:10', script: 'scripts/src/gate10.ts', network: true },
  { id: 'gate:10b', script: 'scripts/src/gate10b.ts', network: true },
  { id: 'gate:11d', script: 'scripts/src/gate11.ts', network: true },
  { id: 'gate:11e', script: 'scripts/src/gate11e.ts', network: true },
  { id: 'gate:11f', script: 'scripts/src/gate11f.ts', network: true },
  { id: 'gate:11g', script: 'scripts/src/gate11g.ts', network: true },
  { id: 'gate:11h', script: 'scripts/src/gate11h.ts', network: true },
  { id: 'gate:12', script: 'scripts/src/gate12.ts', network: false },
];

async function runCommand(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(cmd, args, { cwd: ROOT, shell: true, env: process.env });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function main() {
  const skipNetwork = process.argv.includes('--skip-network');

  console.log('========================================================================');
  console.log(` WAYPOINT FULL GATE SUITE ${skipNetwork ? '(--skip-network enabled)' : '(all gates)'}`);
  console.log('========================================================================\n');

  interface ResultRow {
    gate: string;
    status: 'PASS' | 'FAIL' | 'SKIPPED';
    durationSec: number;
    notes?: string;
  }

  const results: ResultRow[] = [];
  let anyFailed = false;

  for (const g of GATES) {
    if (skipNetwork && g.network) {
      results.push({
        gate: g.id,
        status: 'SKIPPED',
        durationSec: 0,
        notes: 'Voyage/LLM network gate skipped via --skip-network',
      });
      console.log(`[-] ${g.id.padEnd(12)} SKIPPED (network requirement)`);
      continue;
    }

    process.stdout.write(`[...] Running ${g.id.padEnd(10)} (${g.script})... `);
    const start = Date.now();
    const res = await runCommand('pnpm', ['exec', 'tsx', '--env-file=.env', g.script]);
    const durationSec = Math.round((Date.now() - start) / 100) / 10;

    if (res.code === 0) {
      console.log(`PASS (${durationSec}s)`);
      results.push({ gate: g.id, status: 'PASS', durationSec });
    } else {
      console.log(`FAIL (${durationSec}s)`);
      results.push({ gate: g.id, status: 'FAIL', durationSec, notes: `Exit code ${res.code}` });
      anyFailed = true;
      // Do not stop — run as many as possible or stop on fail
    }
  }

  console.log('\n========================================================================');
  console.log(' GATE SUITE SUMMARY TABLE');
  console.log('========================================================================');
  console.log('| Gate       | Status    | Duration | Notes                                  |');
  console.log('|------------|-----------|----------|----------------------------------------|');
  for (const r of results) {
    const gPad = r.gate.padEnd(10);
    const sPad = r.status.padEnd(9);
    const dPad = `${r.durationSec.toFixed(1)}s`.padEnd(8);
    const notes = (r.notes || '').padEnd(38);
    console.log(`| ${gPad} | ${sPad} | ${dPad} | ${notes} |`);
  }
  console.log('========================================================================');

  if (anyFailed) {
    console.error('\n❌ Gate suite failed: one or more gates returned non-zero.');
    process.exit(1);
  } else {
    console.log('\n🎉 Gate suite completed successfully.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[GATE:ALL FATAL]', err);
  process.exit(1);
});
