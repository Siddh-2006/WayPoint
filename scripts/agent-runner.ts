/**
 * scripts/agent-runner.ts
 *
 * Standalone external Agent Runner for Waypoint.
 * Uses the official lightweight Waypoint SDK over HTTP to simulate a real LLM Agent.
 *
 * Usage:
 *   pnpm exec tsx scripts/agent-runner.ts --scenario good --count 20
 *   pnpm exec tsx scripts/agent-runner.ts --scenario good --ship-change bad_deploy --count 30
 *   pnpm exec tsx scripts/agent-runner.ts --loop --interval-ms 500
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWaypoint, type ContextPayload } from '../sdk/src/index.js';
import { runAgent, type InvoiceInput } from '../demo/invoice-agent/agent.js';
import { loadEnv } from './src/env.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, '../demo/invoice-agent/corpus.json');
const corpus: InvoiceInput[] = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8'));

// Parse CLI flags
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]!;
  return fallback;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

const url = getArg('--url', process.env['WAYPOINT_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
const project = getArg('--project', 'demo-live');
const initialScenario = getArg('--scenario', 'good') as ScenarioKey;
const shipChangeScenario = (args.indexOf('--ship-change') !== -1 ? args[args.indexOf('--ship-change') + 1] : undefined) as ScenarioKey | undefined;
const count = parseInt(getArg('--count', '20'), 10);
const intervalMs = parseInt(getArg('--interval-ms', '400'), 10);
const loop = hasFlag('--loop');
const seedArg = getArg('--seed', '42');

const apiKey = process.env['WAYPOINT_API_KEY'] || process.env['API_KEYS']?.split(',')[0]?.trim() || 'test-key-local';

// Scenario definitions
type ScenarioKey = 'good' | 'bad_deploy' | 'model_only' | 'prompt_only' | 'proposed_v3';

const SCENARIOS: Record<ScenarioKey, { model: string; promptText: string; config: Record<string, unknown>; desc: string }> = {
  good: {
    desc: 'model v1 + camelCase prompt rule (Clean Baseline)',
    model: 'v1',
    promptText: 'Extract invoices accurately.\nAlways use camelCase keys in tool arguments.\nReturn JSON.',
    config: { chunkSize: 512, temperature: 0.5 },
  },
  bad_deploy: {
    desc: 'model v2 + missing camelCase rule (Triggers Silent Bug)',
    model: 'v2',
    promptText: 'Extract invoices accurately.\nEnsure total is correct.\nReturn JSON.',
    config: { chunkSize: 256, temperature: 0.5 },
  },
  model_only: {
    desc: 'model v2 + camelCase prompt preserved (Safe upgrade)',
    model: 'v2',
    promptText: 'Extract invoices accurately.\nAlways use camelCase keys in tool arguments.\nReturn JSON.',
    config: { chunkSize: 512, temperature: 0.5 },
  },
  prompt_only: {
    desc: 'model v1 + old prompt (Safe)',
    model: 'v1',
    promptText: 'Extract invoices accurately.\nEnsure total is correct.\nReturn JSON.',
    config: { chunkSize: 512, temperature: 0.5 },
  },
  proposed_v3: {
    desc: 'model v3 bump (Candidate for preflight check)',
    model: 'v3',
    promptText: 'Extract invoices accurately.\nEnsure total is correct.\nReturn JSON.',
    config: { chunkSize: 256, temperature: 0.5 },
  },
};

// Colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

async function main() {
  if (!project.startsWith('demo-') && project !== 'demo') {
    console.error(`${RED}Error: Project ID "${project}" is invalid. Sandbox projects must start with "demo-".${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}========================================================================${RESET}`);
  console.log(` ${CYAN}WAYPOINT EXTERNAL AGENT RUNNER${RESET}`);
  console.log(`${BOLD}========================================================================${RESET}`);
  console.log(` Target URL     : ${url}`);
  console.log(` Project ID     : ${project}`);
  console.log(` Start Scenario : ${initialScenario} (${SCENARIOS[initialScenario]?.desc})`);
  if (shipChangeScenario) {
    console.log(` Mid-run Shift  : ${shipChangeScenario} (after ${Math.floor(count / 2)} runs)`);
  }
  console.log(` Concurrency    : Sequential (interval ${intervalMs}ms)`);
  console.log(` Auth Key       : [SECURELY CONFIGURED, ${apiKey.length} chars]`);
  console.log(`${BOLD}------------------------------------------------------------------------${RESET}\n`);

  const wp = createWaypoint({
    baseUrl: url,
    apiKey,
    projectId: project,
  });

  let currentScenarioKey = initialScenario;
  let currentScenario = SCENARIOS[currentScenarioKey];

  // Register initial context
  let contextHash = await wp.registerContext({
    model: currentScenario.model,
    promptText: currentScenario.promptText,
    config: currentScenario.config,
    toolSchemas: { create_invoice: { type: 'function' } },
  });

  console.log(`${DIM}[init] Registered context:${RESET} hash=${CYAN}${contextHash.slice(0, 10)}${RESET} (${currentScenarioKey})\n`);

  let runIdx = 0;
  let okCount = 0;
  let violationCount = 0;
  const seenHashes = new Set<string>([contextHash]);

  const switchPoint = shipChangeScenario ? Math.floor(count / 2) : -1;

  while (loop || runIdx < count) {
    // Check if mid-run change requested
    if (shipChangeScenario && runIdx === switchPoint && currentScenarioKey !== shipChangeScenario) {
      const prevScenario = currentScenario;
      currentScenarioKey = shipChangeScenario;
      currentScenario = SCENARIOS[currentScenarioKey];
      contextHash = await wp.registerContext({
        model: currentScenario.model,
        promptText: currentScenario.promptText,
        config: currentScenario.config,
        toolSchemas: { create_invoice: { type: 'function' } },
      });
      seenHashes.add(contextHash);

      console.log(`\n${YELLOW}${BOLD}⚡ SHIPPED CHANGE:${RESET} ${YELLOW}model ${prevScenario.model} -> ${currentScenario.model}, switched to ${currentScenarioKey}${RESET}`);
      console.log(`${DIM}   New context hash: ${CYAN}${contextHash.slice(0, 10)}${RESET}\n`);
    }

    const input = corpus[runIdx % corpus.length]!;
    const runSeed = `${seedArg}:${runIdx}`;

    // Execute simulated agent logic
    const agentRes = runAgent({
      context: {
        model: currentScenario.model,
        promptText: currentScenario.promptText,
        config: currentScenario.config,
      },
      input,
      seed: runSeed,
    });

    const isViolation = agentRes.steps.some(
      (s) => s.type === 'tool_call' && 'invoice_id' in (s.contextPayload?.['arguments'] ?? s.contextPayload),
    );

    const timeStr = new Date().toISOString().slice(11, 19);

    // Send through Waypoint SDK
    const runResult = await wp.run(
      { id: input.id, vendor: input.vendor, amount: input.amount },
      async (handle) => {
        for (const step of agentRes.steps) {
          handle.step(step.stepKey, step.contextPayload, step.status, step.type);
        }
        return agentRes.output;
      },
    );

    const runIdShort = runResult.runId.slice(0, 12);
    const hashShort = contextHash.slice(0, 8);

    if (isViolation) {
      violationCount++;
      console.log(
        `[${timeStr}] run=${runIdShort} ctx=${hashShort} ` +
        `${RED}${BOLD}VIOLATION${RESET} (snake_case 'invoice_id' used for ${input.id})`
      );
    } else {
      okCount++;
      console.log(
        `[${timeStr}] run=${runIdShort} ctx=${hashShort} ` +
        `${GREEN}OK${RESET} (camelCase 'invoiceId' extracted: \$${input.amount})`
      );
    }

    runIdx++;

    if (intervalMs > 0 && (loop || runIdx < count)) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  const total = okCount + violationCount;
  const rate = total > 0 ? ((violationCount / total) * 100).toFixed(1) : '0';

  console.log(`\n${BOLD}========================================================================${RESET}`);
  console.log(` ${CYAN}RUN SUMMARY${RESET}`);
  console.log(`${BOLD}========================================================================${RESET}`);
  console.log(` Total Runs       : ${total}`);
  console.log(` Succeeded (OK)   : ${GREEN}${okCount}${RESET}`);
  console.log(` Violations       : ${violationCount > 0 ? RED : GREEN}${violationCount} (${rate}%)${RESET}`);
  console.log(` Contexts Active  : ${seenHashes.size} (${Array.from(seenHashes).map(h => h.slice(0, 8)).join(', ')})`);
  console.log(`${BOLD}========================================================================\n${RESET}`);
}

main().catch((err) => {
  console.error(`\n${RED}[Agent Runner Fatal]${RESET}`, err.message || err);
  process.exit(1);
});
