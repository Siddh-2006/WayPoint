/**
 * server/src/contracts/check.ts
 *
 * Pure function to check run events against mined tool contracts.
 * Rules:
 *   - missing_required_key: a key in requiredKeys was not passed.
 *   - unexpected_similar_key: a required key was missing, but a similar key
 *     (camelCase / snake_case variant) was passed instead.
 *   - wrong_type: a key was passed with a type not matching observed types.
 */

export interface ContractDoc {
  projectId: string;
  tool: string;
  requiredKeys: string[];
  types: Record<string, string[]>;
  support: Record<string, number>;
  minedFrom?: { hash: string; runs: number };
  minedAt?: Date;
}

export interface EventDoc {
  _id?: string;
  eventId?: string;
  projectId?: string;
  runId: string;
  seq?: number;
  type: string;
  status: string;
  stepKey: string;
  contextPayload: Record<string, unknown>;
}

export interface RunViolation {
  eventId: string;
  tool: string;
  rule: 'missing_required_key' | 'unexpected_similar_key' | 'wrong_type';
  expectedKey: string;
  found?: string;
  message: string;
}

/**
 * Normalise a string for fuzzy key matching (ignore case, underscores, and hyphens).
 */
function normaliseKey(k: string): string {
  return k.toLowerCase().replace(/[-_]/g, '');
}

/**
 * Check if a runtime JavaScript value matches any of MongoDB's BSON type strings.
 */
function matchesType(val: unknown, expectedTypes: string[]): boolean {
  if (expectedTypes.length === 0 || expectedTypes.includes('any')) return true;
  if (val === null) return expectedTypes.includes('null');
  if (Array.isArray(val)) return expectedTypes.includes('array');
  if (typeof val === 'number') {
    return expectedTypes.some((t) =>
      ['number', 'double', 'int', 'long', 'decimal'].includes(t),
    );
  }
  if (typeof val === 'string') {
    return expectedTypes.includes('string');
  }
  if (typeof val === 'boolean') {
    return expectedTypes.some((t) => ['bool', 'boolean'].includes(t));
  }
  if (typeof val === 'object') {
    return expectedTypes.includes('object');
  }
  return true;
}

/**
 * Pure function to check events of a run against a list of contracts.
 * Returns an array of violations (empty array if the run conforms to contracts).
 */
export function checkRun(contracts: ContractDoc[], events: EventDoc[]): RunViolation[] {
  const violations: RunViolation[] = [];
  const contractsByTool = new Map<string, ContractDoc>();

  for (const c of contracts) {
    contractsByTool.set(c.tool, c);
  }

  // Filter for tool_call events
  for (const event of events) {
    if (event.type !== 'tool_call') continue;

    const payload = event.contextPayload;
    const tool = typeof payload['tool'] === 'string' ? payload['tool'] : event.stepKey;
    const contract = contractsByTool.get(tool);
    if (!contract) continue;

    const args = (payload['args'] && typeof payload['args'] === 'object' && !Array.isArray(payload['args']))
      ? (payload['args'] as Record<string, unknown>)
      : {};

    const eventId = event._id ?? event.eventId ?? `${event.runId}:${event.seq ?? 0}`;
    const presentKeys = Object.keys(args);
    const presentKeysNormMap = new Map<string, string>();
    for (const pk of presentKeys) {
      presentKeysNormMap.set(normaliseKey(pk), pk);
    }

    // 1. Check required keys
    for (const reqKey of contract.requiredKeys) {
      if (!Object.prototype.hasOwnProperty.call(args, reqKey)) {
        const norm = normaliseKey(reqKey);
        const similarKey = presentKeysNormMap.get(norm);

        if (similarKey && similarKey !== reqKey) {
          violations.push({
            eventId,
            tool,
            rule: 'unexpected_similar_key',
            expectedKey: reqKey,
            found: similarKey,
            message: `key ${reqKey} missing; found ${similarKey}`,
          });
        } else {
          violations.push({
            eventId,
            tool,
            rule: 'missing_required_key',
            expectedKey: reqKey,
            message: `key ${reqKey} missing`,
          });
        }
      }
    }

    // 2. Check types of present keys
    for (const [key, val] of Object.entries(args)) {
      const expectedTypes = contract.types[key];
      if (expectedTypes && expectedTypes.length > 0) {
        if (!matchesType(val, expectedTypes)) {
          violations.push({
            eventId,
            tool,
            rule: 'wrong_type',
            expectedKey: key,
            found: typeof val,
            message: `key ${key} expected type ${expectedTypes.join('|')}; found ${typeof val}`,
          });
        }
      }
    }
  }

  return violations;
}
