/**
 * sdk/src/index.test.ts
 *
 * Unit tests for the Waypoint SDK.
 */

import { describe, expect, it } from 'vitest';
import { createWaypoint, type BufferedEvent } from './index.js';

describe('createWaypoint', () => {
  it('assigns stable sequential event IDs', async () => {
    const receivedBatches: BufferedEvent[][] = [];

    const mockFetch: typeof fetch = async (url, init) => {
      const body = JSON.parse(init?.body as string) as BufferedEvent[];
      receivedBatches.push(body);
      return new Response(JSON.stringify({ results: body.map((e) => ({ status: 'inserted', eventId: e.eventId })) }), {
        status: 201,
      });
    };

    const wp = createWaypoint({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      projectId: 'test-proj',
      fetchFn: mockFetch,
    });

    const runRes = await wp.run({ test: true }, async (run) => {
      run.step('step_a', { val: 1 });
      run.step('step_b', { val: 2 });
      return 'done';
    });

    expect(runRes.result).toBe('done');
    expect(receivedBatches).toHaveLength(1);
    const events = receivedBatches[0]!;

    expect(events).toHaveLength(4); // run_start, step_a, step_b, run_end
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events.map((e) => e.eventId)).toEqual([
      `${runRes.runId}:0`,
      `${runRes.runId}:1`,
      `${runRes.runId}:2`,
      `${runRes.runId}:3`,
    ]);
  });
});
