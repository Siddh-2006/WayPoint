/**
 * server/src/demo/invoice-agent.ts
 *
 * SIMULATED invoice-extraction agent for Waypoint.
 *
 * This agent is SIMULATED and deterministic. Its behaviour is generated via a
 * seeded PRNG (mulberry32) based solely on (model, promptText, config, input, seed).
 *
 * It always returns final status 'ok' (simulating silent HTTP-200-but-wrong failures).
 *
 * Planted failure condition:
 *   - Correct tool call arguments use key `invoiceId`.
 *   - The bug (using snake_case `invoice_id`) triggers ONLY when:
 *       model in {'v2', 'v3'} AND promptText does NOT contain "Always use camelCase keys"
 *       (SIMULATED: v3 deliberately reintroduces the v2 key-naming bug; documented in README)
 *   - config.chunkSize is a decoy: it alters retrieval snippet length but never causes the bug.
 *   - When config.temperature > 0.7, noise is added: bug probability is 0.85 instead of 1.0.
 *   - `frozen` allows substituting previously recorded retrieval text verbatim for replays.
 */

export interface InvoiceInput {
  id: string;
  vendor: string;
  amount: number;
  currency?: string;
  date?: string;
  text?: string;
}

export interface AgentContext {
  model: string;
  promptText: string;
  config?: Record<string, unknown> | undefined;
}

export interface AgentStep {
  stepKey: string;
  type: 'retrieval' | 'tool_call' | 'output';
  status: 'ok';
  contextPayload: Record<string, unknown>;
}

export interface AgentResult {
  simulated: true;
  status: 'ok';
  output: Record<string, unknown>;
  steps: AgentStep[];
}

export interface RunAgentOptions {
  context: AgentContext;
  input: InvoiceInput;
  seed: number | string;
  frozen?: { retrieval?: string } | undefined;
}

/**
 * 32-bit Mulberry PRNG for fast, high-quality, reproducible pseudo-random numbers.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash an input string to an unsigned 32-bit integer seed.
 */
function hashToSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/**
 * Pure, deterministic SIMULATED invoice agent.
 */
export function runAgent(options: RunAgentOptions): AgentResult {
  const { context, input, seed, frozen } = options;

  // Derive stable numeric seed from input + seed
  const numSeed =
    typeof seed === 'number'
      ? (seed >>> 0) ^ hashToSeed(input.id)
      : hashToSeed(`${seed}:${input.id}`);

  const prng = mulberry32(numSeed);

  // 1. Decoy parameter: chunkSize affects retrieval text length
  const chunkSize = typeof context.config?.['chunkSize'] === 'number'
    ? (context.config['chunkSize'] as number)
    : 512;

  let retrievalText: string;
  if (frozen?.retrieval !== undefined) {
    retrievalText = frozen.retrieval;
  } else {
    const raw = input.text ?? `Invoice ${input.id} from ${input.vendor} total: ${input.amount}`;
    retrievalText = raw.slice(0, Math.max(30, chunkSize));
  }

  // 2. Planted failure condition:
  //    model in {'v2', 'v3'} AND promptText does not contain "Always use camelCase keys"
  //    SIMULATED: v3 deliberately reintroduces the v2 key-naming bug to enable demo gate 11h.
  //    Both v2 and v3 carry the same snake_case bug when the camelCase guard is absent.
  const isModelV2orV3 = context.model === 'v2' || context.model === 'v3';
  const hasCamelCaseRule = context.promptText.includes('Always use camelCase keys');
  const bugConditionMet = isModelV2orV3 && !hasCamelCaseRule;

  const temperature = typeof context.config?.['temperature'] === 'number'
    ? (context.config['temperature'] as number)
    : 0.5;

  let hasBug = false;
  if (bugConditionMet) {
    if (temperature > 0.7) {
      // Noise mode: 85% probability under high temperature
      hasBug = prng() < 0.85;
    } else {
      // Deterministic failure
      hasBug = true;
    }
  }

  // Correct key is "invoiceId"; bug produces "invoice_id"
  const toolArgs = {
    [hasBug ? 'invoice_id' : 'invoiceId']: input.id,
    vendor: input.vendor,
    amount: input.amount,
    currency: input.currency ?? 'USD',
  };

  const steps: AgentStep[] = [
    {
      stepKey: 'retrieval',
      type: 'retrieval',
      status: 'ok',
      contextPayload: {
        query: input.id,
        retrievedLength: retrievalText.length,
        retrieval: retrievalText,
        chunkSize,
      },
    },
    {
      stepKey: 'create_invoice',
      type: 'tool_call',
      status: 'ok',
      contextPayload: {
        tool: 'create_invoice',
        args: toolArgs,
      },
    },
    {
      stepKey: 'output',
      type: 'output',
      status: 'ok',
      contextPayload: {
        result: `Successfully processed invoice ${input.id}`,
        invoiceId: input.id,
        model: context.model,
      },
    },
  ];

  return {
    simulated: true,
    status: 'ok',
    output: {
      invoiceId: input.id,
      vendor: input.vendor,
      amount: input.amount,
      processed: true,
    },
    steps,
  };
}

