/**
 * server/src/index.ts
 *
 * Fastify application entry point.
 * - Registers CORS, ingest routes.
 * - Exposes GET /health (includes searchIndexes status).
 * - Connects to MongoDB and runs DB init on startup.
 * - Graceful shutdown on SIGINT / SIGTERM.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { connectDb, closeDb, getClient, getDb } from './db/client.js';
import { ingestRoutes } from './ingest/routes.js';
import { contextRoutes } from './contexts/routes.js';
import { demoRoutes } from './demo/routes.js';
import { contractRoutes } from './contracts/routes.js';
import { incidentRoutes } from './detect/routes.js';
import { streamRoutes } from './stream/routes.js';
import { replayRoutes } from './replay/routes.js';
import { startDetector, stopDetector } from './detect/detector.js';
import * as dbInit from './db/init.js';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    // Structured JSON in production; pretty-print in dev
    ...(config.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true },
          },
        }
      : {}),
  },
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

await app.register(cors, { origin: config.CORS_ORIGIN });

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', async () => {
  let mongo: 'up' | 'down' = 'down';
  try {
    await getClient().db('admin').command({ ping: 1 });
    mongo = 'up';
  } catch {
    // intentionally swallowed — health never throws
  }
  return {
    ok: mongo === 'up',
    mongo,
    searchIndexes: dbInit.searchIndexStatus,
    time: new Date().toISOString(),
  };
});

await app.register(ingestRoutes);
await app.register(contextRoutes);
await app.register(demoRoutes);
await app.register(contractRoutes);
await app.register(incidentRoutes);
await app.register(streamRoutes);
await app.register(replayRoutes);

// ─── Static Files & SPA Fallback ─────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(__dirname, '../../web/dist');

if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    wildcard: false,
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/v1/')) {
      return reply.code(404).send({ error: 'Endpoint not found' });
    }
    return reply.sendFile('index.html');
  });
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await connectDb();
  // Idempotent: safe to call on every boot.
  // Search index creation is best-effort — see initDb() for details.
  await dbInit.initDb(getDb());

  // Mark any orphaned 'running' experiments as failed due to restart (no zombie states)
  await getDb()
    .collection('experiments')
    .updateMany(
      { status: 'running' },
      { $set: { status: 'failed', reason: 'restarted', endedAt: new Date() } },
    );

  // Start real-time incident detector on runs change stream
  await startDetector(getDb());

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(
    { port: config.PORT, env: config.NODE_ENV },
    'Waypoint server ready',
  );
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down…');
  await stopDetector();
  await app.close();
  await closeDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

start().catch((err: unknown) => {
  console.error('[Waypoint] Fatal startup error:', err);
  process.exit(1);
});
