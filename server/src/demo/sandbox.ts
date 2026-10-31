/**
 * server/src/demo/sandbox.ts
 *
 * Per-session sandbox isolation and rate limiting.
 *
 * Sandbox Rules:
 *   - sessionId provided via header 'x-demo-session' or query param 'sessionId'.
 *   - sessionId must match standard UUID format.
 *   - projectId = "demo-" + sha256(sessionId).slice(0, 12).
 *   - Public read access applies to all projectIds matching config.READ_PUBLIC_PREFIX (default "demo-").
 *   - Concurrent reset guard: atomic in-memory or DB lock per sandbox; 2nd concurrent reset yields 409.
 *   - Cleanup: deletes ONLY documents where projectId starts with "demo-" and is older than SANDBOX_TTL_HOURS.
 *   - Rate limiting: max RATE_LIMIT_PER_MINUTE per IP/sessionId -> 429 when exceeded.
 */

import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { config } from '../config.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SandboxInfo {
  sessionId: string;
  projectId: string;
}

/**
 * Derives a deterministic sandbox projectId from a valid sessionId.
 * Returns null if the sessionId is invalid.
 */
export function deriveSandbox(sessionId: string | undefined): SandboxInfo | null {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const trimmed = sessionId.trim();
  if (!UUID_REGEX.test(trimmed)) return null;

  const hex = createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
  const projectId = `${config.READ_PUBLIC_PREFIX || 'demo-'}${hex}`;
  return { sessionId: trimmed, projectId };
}

/**
 * Validates whether a projectId belongs to the public demo prefix.
 */
export function isPublicDemoProject(projectId: string): boolean {
  if (config.READ_PUBLIC_PROJECTS.includes(projectId)) return true;
  const prefix = config.READ_PUBLIC_PREFIX || 'demo-';
  return projectId.startsWith(prefix);
}

// In-memory locks for concurrent resets per sandbox
const activeResetLocks = new Set<string>();

export function acquireResetLock(projectId: string): boolean {
  if (activeResetLocks.has(projectId)) return false;
  activeResetLocks.add(projectId);
  return true;
}

export function releaseResetLock(projectId: string): void {
  activeResetLocks.delete(projectId);
}

// In-memory sliding window rate limiter
interface RateRecord {
  count: number;
  resetAt: number;
}
const rateLimitMap = new Map<string, RateRecord>();

export function checkRateLimit(key: string, limit: number = config.RATE_LIMIT_PER_MINUTE): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const record = rateLimitMap.get(key);

  if (!record || now > record.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + 60_000 });
    return { allowed: true, remaining: limit - 1 };
  }

  if (record.count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  record.count++;
  return { allowed: true, remaining: limit - record.count };
}

/**
 * Clean up sandboxes older than SANDBOX_TTL_HOURS.
 * Enforces that MAX_SANDBOXES limit is not breached.
 * Deletes ONLY documents belonging to projectIds with prefix "demo-".
 */
export async function cleanupExpiredSandboxes(db: Db): Promise<{ cleanedSandboxes: number; deletedDocs: number }> {
  const prefix = config.READ_PUBLIC_PREFIX || 'demo-';
  const ttlMs = (config.SANDBOX_TTL_HOURS || 2) * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - ttlMs);

  const collections = ['runs', 'events', 'contexts', 'deployments', 'contracts', 'incidents', 'experiments', 'lessons'];
  
  // Find deployments that start with prefix and updated before cutoff
  const deploymentsCol = db.collection('deployments');
  const expiredDeployments = await deploymentsCol
    .find({
      projectId: { $regex: `^${prefix}` },
      updatedAt: { $lt: cutoff },
    })
    .toArray();

  let cleanedSandboxes = 0;
  let deletedDocs = 0;

  for (const dep of expiredDeployments) {
    const pId = dep.projectId as string;
    // Strict safety check: never delete non-demo projects
    if (!pId.startsWith(prefix)) continue;

    for (const cName of collections) {
      const res = await db.collection(cName).deleteMany({ projectId: pId });
      deletedDocs += res.deletedCount;
    }
    cleanedSandboxes++;
  }

  // Also enforce MAX_SANDBOXES if total active sandboxes exceeds MAX_SANDBOXES
  const maxSandboxes = config.MAX_SANDBOXES || 50;
  const activeDeployments = await deploymentsCol
    .find({ projectId: { $regex: `^${prefix}` } })
    .sort({ updatedAt: 1 })
    .toArray();

  if (activeDeployments.length > maxSandboxes) {
    const excess = activeDeployments.slice(0, activeDeployments.length - maxSandboxes);
    for (const dep of excess) {
      const pId = dep.projectId as string;
      if (!pId.startsWith(prefix)) continue;
      for (const cName of collections) {
        const res = await db.collection(cName).deleteMany({ projectId: pId });
        deletedDocs += res.deletedCount;
      }
      cleanedSandboxes++;
    }
  }

  return { cleanedSandboxes, deletedDocs };
}
