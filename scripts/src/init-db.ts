/**
 * scripts/src/init-db.ts
 *
 * CLI entry point for DB initialisation.
 * The actual logic lives in server/src/db/init.ts (single source of truth).
 *
 * Usage:
 *   pnpm db:init
 *   tsx scripts/src/init-db.ts
 */

import { MongoClient } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';
// Re-export so gate2 can import initDb from this module without a server dep
export { initDb } from '../../server/src/db/init.js';

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('init-db.ts') || process.argv[1]?.endsWith('init-db.js')) {
  loadEnv();
  const uri = requireEnv('MONGODB_URI');
  const dbName = requireEnv('MONGODB_DB');
  const { initDb } = await import('../../server/src/db/init.js');
  const client = new MongoClient(uri);
  try {
    await client.connect();
    await initDb(client.db(dbName));
    console.log('[init-db] Done.');
  } finally {
    await client.close();
  }
}
