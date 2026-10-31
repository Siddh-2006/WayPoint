/**
 * demo/invoice-agent/agent.ts
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
 *       model === 'v2' AND promptText does NOT contain "Always use camelCase keys"
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
    frozen?: {
        retrieval?: string;
    } | undefined;
}
/**
 * 32-bit Mulberry PRNG for fast, high-quality, reproducible pseudo-random numbers.
 */
export declare function mulberry32(seed: number): () => number;
/**
 * Pure, deterministic SIMULATED invoice agent.
 */
export declare function runAgent(options: RunAgentOptions): AgentResult;
//# sourceMappingURL=agent.d.ts.map