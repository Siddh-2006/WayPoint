/**
 * server/src/stream/routes.ts
 *
 * Real-time Server-Sent Events (SSE) route:
 *   GET /v1/stream — streams real-time updates for runs and incidents.
 *
 * Architecture (Decision D30):
 *   - Singleton shared MongoDB change streams on runs and incidents
 *   - In-memory fan-out to all active connected SSE clients (prevents Atlas M0 connection/stream exhaustion)
 *   - Enforces MAX_SSE_CLIENTS limit (returns 429 when cap reached)
 *   - Periodic 15s heartbeat per connection to prevent proxy timeouts
 *   - Zero secrets leaked via deep redact() before broadcast
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { redact } from '../ingest/redact.js';

interface SseClient {
  id: string;
  write: (data: string) => void;
  close: () => void;
}

const activeClients = new Set<SseClient>();
let streamsStarted = false;
let clientCounter = 0;

function broadcast(type: string, doc: Record<string, unknown>): void {
  if (activeClients.size === 0) return;
  const cleanDoc = redact(doc);
  const payload = `event: message\ndata: ${JSON.stringify({ type, doc: cleanDoc })}\n\n`;
  for (const client of activeClients) {
    try {
      client.write(payload);
    } catch {
      // client write failed, will be removed on close
    }
  }
}

function ensureSharedChangeStreams(db: Db): void {
  if (streamsStarted) return;
  streamsStarted = true;

  try {
    const runsCol = db.collection('runs');
    const runsStream = runsCol.watch([], { fullDocument: 'updateLookup' });

    (async () => {
      try {
        for await (const change of runsStream) {
          const fullDoc = (change as { fullDocument?: Record<string, unknown> }).fullDocument;
          if (fullDoc) {
            broadcast('run', fullDoc);
          }
        }
      } catch (err: any) {
        console.warn('[SSE] Runs shared change stream closed:', err?.message || err);
        streamsStarted = false;
      }
    })();
  } catch (err: any) {
    console.warn('[SSE] Could not watch runs change stream (change streams might not be supported in standalone):', err?.message || err);
    streamsStarted = false;
  }

  try {
    const incidentsCol = db.collection('incidents');
    const incidentsStream = incidentsCol.watch([], { fullDocument: 'updateLookup' });

    (async () => {
      try {
        for await (const change of incidentsStream) {
          const fullDoc = (change as { fullDocument?: Record<string, unknown> }).fullDocument;
          if (fullDoc) {
            broadcast('incident', fullDoc);
          }
        }
      } catch (err: any) {
        console.warn('[SSE] Incidents shared change stream closed:', err?.message || err);
      }
    })();
  } catch (err: any) {
    console.warn('[SSE] Could not watch incidents change stream:', err?.message || err);
  }
}

export function getActiveSseClientCount(): number {
  return activeClients.size;
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/v1/stream', async (req, reply) => {
    // 1. Cap concurrent clients
    if (activeClients.size >= config.MAX_SSE_CLIENTS) {
      return reply.code(429).send({ error: 'Max concurrent SSE clients reached' });
    }

    // 2. Ensure singleton shared change streams are active
    ensureSharedChangeStreams(db);

    // 3. Set SSE response headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': config.CORS_ORIGIN,
      'X-Accel-Buffering': 'no',
    });

    reply.raw.flushHeaders?.();

    // Send initial connected event and heartbeat ping
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
    reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);

    // 4. Register client in fan-out set
    const clientId = `sse_${++clientCounter}_${Date.now()}`;
    let isClosed = false;

    const heartbeatTimer = setInterval(() => {
      if (isClosed) return;
      try {
        reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
      } catch {
        cleanup();
      }
    }, 15_000);

    const sseClient: SseClient = {
      id: clientId,
      write: (data: string) => {
        if (!isClosed) reply.raw.write(data);
      },
      close: () => cleanup(),
    };

    function cleanup(): void {
      if (isClosed) return;
      isClosed = true;
      activeClients.delete(sseClient);
      clearInterval(heartbeatTimer);
    }

    activeClients.add(sseClient);
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    // Keep request open until client closes
    await new Promise((resolve) => {
      req.raw.on('close', resolve);
    });
  });
}
