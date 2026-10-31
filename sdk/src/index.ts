/**
 * sdk/src/index.ts
 *
 * Lightweight, zero-heavy-dependency client SDK for Waypoint.
 *
 * Capabilities:
 *   - wp.registerContext(ctx) -> returns contentHash
 *   - wp.run(input, fn) -> assigns stable eventIds as ${runId}:${seq}
 *   - wp.step(stepKey, payload, status?) -> buffers events and flushes in batches <= 100
 *   - Automatic retry with exponential backoff (up to 5 attempts)
 *   - Idempotent: safe against network retries
 */

export interface WaypointConfig {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  fetchFn?: typeof fetch | undefined;
}

export interface ContextPayload {
  model: string;
  promptText: string;
  config?: Record<string, unknown>;
  toolSchemas?: Record<string, unknown>;
  deps?: Record<string, unknown>;
}

export type EventType =
  | 'run_start'
  | 'context'
  | 'step'
  | 'tool_call'
  | 'retrieval'
  | 'output'
  | 'run_end'
  | 'error';

export type EventStatus = 'ok' | 'error' | 'violation';

export interface BufferedEvent {
  eventId: string;
  projectId: string;
  runId: string;
  seq: number;
  ts: string;
  type: EventType;
  status: EventStatus;
  stepKey: string;
  contextPayload: Record<string, unknown>;
}

export interface RunHandle {
  runId: string;
  step: (
    stepKey: string,
    payload: Record<string, unknown>,
    status?: EventStatus,
    type?: EventType,
  ) => void;
  flush: () => Promise<void>;
}

export interface WaypointClient {
  registerContext: (ctx: ContextPayload) => Promise<string>;
  run: <T>(
    input: unknown,
    fn: (run: RunHandle) => Promise<T>,
    options?: { contextHash?: string },
  ) => Promise<{ runId: string; result: T }>;
  flushEvents: (events: BufferedEvent[]) => Promise<void>;
}

/**
 * Exponential backoff sleep helper.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createWaypoint(config: WaypointConfig): WaypointClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const apiKey = config.apiKey;
  const projectId = config.projectId;
  const customFetch = config.fetchFn ?? fetch;

  /**
   * Send a batch of events (<= 100) with exponential backoff retries.
   */
  async function sendBatch(batch: BufferedEvent[], maxRetries = 5): Promise<void> {
    if (batch.length === 0) return;

    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const res = await customFetch(`${baseUrl}/v1/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify(batch),
        });

        // 201 (inserted) or 207 (mixed/duplicate_ignored) indicate success
        if (res.status === 201 || res.status === 207) {
          return;
        }

        // 4xx client errors (e.g. 401, 422) should not be blindly retried
        if (res.status >= 400 && res.status < 500) {
          const errBody = await res.text().catch(() => '');
          throw new Error(`Waypoint client error HTTP ${res.status}: ${errBody}`);
        }

        // 5xx server error, retry with backoff
        attempt++;
        if (attempt >= maxRetries) {
          throw new Error(`Waypoint server error HTTP ${res.status} after ${maxRetries} retries`);
        }
        await sleep(Math.pow(2, attempt) * 50);
      } catch (err) {
        attempt++;
        if (attempt >= maxRetries) {
          throw err;
        }
        await sleep(Math.pow(2, attempt) * 50);
      }
    }
  }

  /**
   * Flush an array of events in chunks of at most 100.
   */
  async function flushEvents(events: BufferedEvent[]): Promise<void> {
    const CHUNK_SIZE = 100;
    for (let i = 0; i < events.length; i += CHUNK_SIZE) {
      const chunk = events.slice(i, i + CHUNK_SIZE);
      await sendBatch(chunk);
    }
  }

  return {
    async registerContext(ctx: ContextPayload): Promise<string> {
      const res = await customFetch(`${baseUrl}/v1/contexts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ projectId, ...ctx }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Failed to register context: HTTP ${res.status} ${errText}`);
      }

      const data = (await res.json()) as { hash: string };
      return data.hash;
    },

    async run<T>(
      input: unknown,
      fn: (run: RunHandle) => Promise<T>,
      options?: { contextHash?: string },
    ): Promise<{ runId: string; result: T }> {
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let seq = 0;
      const buffer: BufferedEvent[] = [];

      // Start run event
      buffer.push({
        eventId: `${runId}:${seq}`,
        projectId,
        runId,
        seq: seq++,
        ts: new Date().toISOString(),
        type: 'run_start',
        status: 'ok',
        stepKey: 'run_start',
        contextPayload: {
          input,
          contextHash: options?.contextHash ?? null,
        },
      });

      const runHandle: RunHandle = {
        runId,
        step(stepKey, payload, status = 'ok', type = 'step') {
          buffer.push({
            eventId: `${runId}:${seq}`,
            projectId,
            runId,
            seq: seq++,
            ts: new Date().toISOString(),
            type,
            status,
            stepKey,
            contextPayload: payload,
          });
        },
        async flush() {
          if (buffer.length > 0) {
            const toSend = [...buffer];
            buffer.length = 0;
            await flushEvents(toSend);
          }
        },
      };

      try {
        const result = await fn(runHandle);

        // End run event
        buffer.push({
          eventId: `${runId}:${seq}`,
          projectId,
          runId,
          seq: seq++,
          ts: new Date().toISOString(),
          type: 'run_end',
          status: 'ok',
          stepKey: 'run_end',
          contextPayload: {
            output: typeof result === 'object' && result !== null ? result : { result },
          },
        });

        // Flush all remaining buffered events
        await flushEvents(buffer);

        return { runId, result };
      } catch (err) {
        // Record error event
        buffer.push({
          eventId: `${runId}:${seq}`,
          projectId,
          runId,
          seq: seq++,
          ts: new Date().toISOString(),
          type: 'error',
          status: 'error',
          stepKey: 'error',
          contextPayload: {
            error: err instanceof Error ? err.message : String(err),
          },
        });

        await flushEvents(buffer).catch(() => undefined);
        throw err;
      }
    },

    flushEvents,
  };
}

