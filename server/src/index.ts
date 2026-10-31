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
import * as dbInit from './db/init.js';

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

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await connectDb();
  // Idempotent: safe to call on every boot.
  // Search index creation is best-effort — see initDb() for details.
  await dbInit.initDb(getDb());
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(
    { port: config.PORT, env: config.NODE_ENV },
    'Waypoint server ready',
  );
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down…');
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
