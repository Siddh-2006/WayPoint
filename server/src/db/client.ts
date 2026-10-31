/**
 * server/src/db/client.ts
 *
 * Shared MongoClient singleton.  Modules call getDb() to get a Db handle;
 * they never instantiate their own clients.
 */

import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.js';

let _client: MongoClient | null = null;

/** Return the singleton MongoClient (not yet connected). */
export function getClient(): MongoClient {
  if (!_client) {
    _client = new MongoClient(config.MONGODB_URI, {
      // Use a short server-selection timeout so startup failures are obvious.
      serverSelectionTimeoutMS: 10_000,
    });
  }
  return _client;
}

/** Return a Db handle for the configured database. */
export function getDb(): Db {
  return getClient().db(config.MONGODB_DB);
}

/** Connect to MongoDB.  Call once at server startup. */
export async function connectDb(): Promise<void> {
  await getClient().connect();
}

/** Close the connection.  Call during graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
  }
}
