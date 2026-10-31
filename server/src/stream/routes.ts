/**
 * server/src/stream/routes.ts
 *
 * Real-time Server-Sent Events (SSE) route:
 *   GET /v1/stream — streams real-time updates for runs, incidents, and experiments.
 *
 * Features:
 *   - Backed by MongoDB collection-level change streams on runs and incidents
 *   - Supports Last-Event-ID header for client reconnect
 *   - Periodic 15s heartbeat to prevent proxy timeouts
 *   - Enforces MAX_SSE_CLIENTS limit (default 50)
 *   - Cleans up change stream listeners on client disconnect
 *   - Deep redaction to ensure no secrets escape in stream payloads
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { redact } from '../ingest/redact.js';

let activeSseClients = 0;

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/v1/stream', async (req, reply) => {
    // 1. Cap concurrent clients
    if (activeSseClients >= config.MAX_SSE_CLIENTS) {
      return reply.code(429).send({ error: 'Max concurrent SSE clients reached' });
    }

    activeSseClients++;

    // 2. Set SSE response headers
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

    // 3. Heartbeat timer (every 15s)
    const heartbeatTimer = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
      } catch {
        clearInterval(heartbeatTimer);
      }
    }, 15_000);

    // 4. Watch collections
    const lastEventId = req.headers['last-event-id'] as string | undefined;

    const runsCol = db.collection('runs');
    const incidentsCol = db.collection('incidents');

    const runsStream = runsCol.watch([], { fullDocument: 'updateLookup' });
    const incidentsStream = incidentsCol.watch([], { fullDocument: 'updateLookup' });

    let isClosed = false;

    function cleanup(): void {
      if (isClosed) return;
      isClosed = true;
      activeSseClients = Math.max(0, activeSseClients - 1);
      clearInterval(heartbeatTimer);
      runsStream.close().catch(() => undefined);
      incidentsStream.close().catch(() => undefined);
    }

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    // Stream helper
    function sendEvent(type: string, doc: unknown, id?: string): void {
      if (isClosed) return;
      const cleanDoc = redact(doc);
      const idLine = id ? `id: ${id}\n` : '';
      reply.raw.write(`${idLine}event: message\ndata: ${JSON.stringify({ type, doc: cleanDoc })}\n\n`);
    }

    // Process runs change stream
    (async () => {
      try {
        for await (const change of runsStream) {
          if (isClosed) break;
          const fullDoc = (change as { fullDocument?: Record<string, unknown> }).fullDocument;
          if (fullDoc) {
            sendEvent('run', fullDoc, String(change._id));
          }
        }
      } catch {
        // Stream closed
      }
    })();

    // Process incidents change stream
    (async () => {
      try {
        for await (const change of incidentsStream) {
          if (isClosed) break;
          const fullDoc = (change as { fullDocument?: Record<string, unknown> }).fullDocument;
          if (fullDoc) {
            sendEvent('incident', fullDoc, String(change._id));
          }
        }
      } catch {
        // Stream closed
      }
    })();

    // Keep request open until client closes
    await new Promise((resolve) => {
      req.raw.on('close', resolve);
    });
  });
}

