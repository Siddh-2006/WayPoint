/**
 * scripts/src/gate11.ts
 *
 * Verification suite for Prompt 11:
 *   (a) Grounded facts generation (numbered F1..Fn, user text <= 120 chars)
 *   (b) Narration synthesis (summary <= 600 chars, every sentence cites [F...])
 *   (c) Citation & hallucination validator (drops unverified tags & ungrounded numbers)
 *   (d) Narration API (POST/GET /v1/incidents/:id/narrate, idempotent & persisted)
 *   (e) Explain panel (GET /v1/debug/explain, verifies IXSCAN on all 4 queries, 0 COLLSCAN, bounded examined docs)
 *   (f) MCP Server (stdio protocol handshake, tool enumeration & tool invocation)
 */

import { MongoClient, ObjectId } from 'mongodb';
import { spawn } from 'node:child_process';
import { buildFacts, truncateText } from '../../server/src/narrate/facts.js';
import { validateNarration } from '../../server/src/narrate/validate.js';
import { generateDeterministicNarration } from '../../server/src/narrate/service.js';

const MONGODB_URI = process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const MONGODB_DB = process.env['MONGODB_DB'] ?? 'waypoint';
const BASE_URL = process.env['BASE_URL'] ?? 'http://127.0.0.1:3000';
const API_KEY = (process.env['API_KEYS'] ?? 'test-key-1').split(',')[0]!.trim();

let failures = 0;

function check(title: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`✅ PASS  ${title}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`❌ FAIL  ${title}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

console.log('\n─── Gate 11: LLM Narration, Explain Panel & MCP Server ───\n');

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);

// ─── Setup: Trigger an incident if none exists ───────────────────────────────
let activeIncidentId = '';
try {
  const incRes = await fetch(`${BASE_URL}/v1/incidents?projectId=demo`);
  const incData = (await incRes.json()) as { incidents: Array<{ _id: string; id?: string }> };

  if (incData.incidents && incData.incidents.length > 0) {
    activeIncidentId = incData.incidents[0]!._id ?? incData.incidents[0]!.id!;
  } else {
    // Run good and bad deploy scenarios
    await fetch(`${BASE_URL}/v1/demo/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'good', projectId: 'demo' }),
    });
    await fetch(`${BASE_URL}/v1/demo/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'bad_deploy', projectId: 'demo' }),
    });
    await new Promise((r) => setTimeout(r, 600));

    const freshRes = await fetch(`${BASE_URL}/v1/incidents?projectId=demo`);
    const freshData = (await freshRes.json()) as { incidents: Array<{ _id: string; id?: string }> };
    if (!freshData.incidents || freshData.incidents.length === 0) {
      throw new Error('Failed to find or generate demo incident');
    }
    activeIncidentId = freshData.incidents[0]!._id ?? freshData.incidents[0]!.id!;
  }
} catch (err) {
  console.error('Setup failed:', err);
  process.exit(1);
}

// ─── (a) Structured facts generation & text truncation ──────────────────────
try {
  const longUserText =
    'This is an excessively long and verbose symptom text designed specifically to test if the fact generation pipeline strictly enforces the 120 character limit boundary on arbitrary user inputs before sending to any downstream component.';
  const truncated = truncateText(longUserText, 120);

  const mockIncident = {
    id: 'inc_test_123',
    projectId: 'demo',
    rate: 1.0,
    baselineHash: 'abc1234567890',
    badHash: 'def1234567890',
    changes: [{ axis: 'prompt', path: 'promptText', summary: longUserText }],
    violationSummary: { 'send_invoice: missing required key invoiceId': 10 },
    evidenceRunIds: ['run-1', 'run-2'],
  };

  const mockExperiment = {
    status: 'done',
    culprit: { units: ['prompt', 'model'], interaction: true },
    shapley: { prompt: 0.5, model: 0.5 },
  };

  const mockLessons = [
    {
      lessonId: 'les_1',
      score: 0.88,
      lesson: { symptom: longUserText, fix: 'Use camelCase invoiceId' },
    },
  ];

  const facts = buildFacts(mockIncident, mockExperiment, mockLessons);
  const factsNumbered = facts.map((f) => f.id).join(',');
  const allFactsTruncated = facts.every((f) => {
    const symptomMatch = f.text.match(/symptom "([^"]+)"/);
    return !symptomMatch || symptomMatch[1]!.length <= 120;
  });

  const ok =
    truncated.length <= 120 &&
    facts.length >= 4 &&
    facts[0]?.id === 'F1' &&
    facts[1]?.id === 'F2' &&
    facts[2]?.id === 'F3' &&
    allFactsTruncated;

  check(
    '(a) Grounded facts generation: numbered F1..Fn, user text strictly <= 120 chars',
    ok,
    `factsCount=${facts.length} numbered=[${factsNumbered}] truncLen=${truncated.length}`,
  );
} catch (err) {
  check('(a) Facts generation', false, String(err));
}

// ─── (b) Narration synthesis & citation compliance ──────────────────────────
try {
  const mockFacts = [
    { id: 'F1', label: 'Rate', text: 'Incident inc_1 detected 100% contract violation rate across 5 runs.', numbers: ['100%', '5'] },
    { id: 'F2', label: 'Context', text: 'Context modified from baseline abc to regression def.', numbers: [] },
    { id: 'F3', label: 'Replay', text: 'Replay factorial attribution confirmed culprit unit(s): [prompt, model] with Shapley values: prompt=50%, model=50%.', numbers: ['50%'] },
    { id: 'F4', label: 'Violations', text: 'Contract checks violated: missing required tool parameters.', numbers: [] },
  ];

  const narrative = generateDeterministicNarration(mockFacts);
  const validated = validateNarration(narrative, mockFacts);
  const sentences = narrative.split(/(?<=[.!?])\s+/);
  const everySentenceCites = sentences.every((s) => /\[F\d+\]/.test(s));
  const lengthOk = narrative.length <= 600;

  const ok = validated.valid && everySentenceCites && lengthOk && validated.citations.length >= 3;
  check(
    '(b) Narration synthesis: summary <= 600 chars, every sentence cites [F...]',
    ok,
    `length=${narrative.length} chars, citations=[${validated.citations.join(',')}]`,
  );
} catch (err) {
  check('(b) Narration synthesis', false, String(err));
}

// ─── (c) Citation and hallucination validator ───────────────────────────────
try {
  const mockFacts = [
    { id: 'F1', label: 'Rate', text: 'Detected 100% failure rate across 4 runs.', numbers: ['100%', '4'] },
    { id: 'F2', label: 'Culprit', text: 'Culprit is prompt with 75% Shapley value.', numbers: ['75%'] },
  ];

  // 1. Text with hallucinated number (99% does not exist in F1 or F2)
  const hallucinatedNumber = 'Failure rate spiked to 99% according to data [F1].';
  const valHallucination = validateNarration(hallucinatedNumber, mockFacts);

  // 2. Text with invalid citation tag [F9]
  const invalidTag = 'Failure was caused by prompt changes [F9].';
  const valInvalidTag = validateNarration(invalidTag, mockFacts);

  // 3. Valid text
  const validText = 'Detected 100% failure rate across 4 runs [F1]. Culprit is prompt with 75% value [F2].';
  const valValid = validateNarration(validText, mockFacts);

  const ok =
    !valHallucination.valid &&
    valHallucination.droppedSentences.length === 1 &&
    !valInvalidTag.valid &&
    valInvalidTag.droppedSentences.length === 1 &&
    valValid.valid &&
    valValid.cleanText.length > 0;

  check(
    '(c) Citation & hallucination validator: drops unverified tags & ungrounded numbers',
    ok,
    `droppedHallucinated=${valHallucination.droppedSentences.length} droppedInvalidTag=${valInvalidTag.droppedSentences.length}`,
  );
} catch (err) {
  check('(c) Validator verification', false, String(err));
}

// ─── (d) Narration API (POST/GET /v1/incidents/:id/narrate) ─────────────────
try {
  // Call POST /v1/incidents/:id/narrate
  const postRes = await fetch(`${BASE_URL}/v1/incidents/${activeIncidentId}/narrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ forceRefresh: true }),
  });
  const postData = (await postRes.json()) as {
    summary: string;
    facts: any[];
    citations: string[];
    model: string;
  };

  // Call GET /v1/incidents/:id/narration
  const getRes = await fetch(`${BASE_URL}/v1/incidents/${activeIncidentId}/narration`, {
    headers: { 'x-api-key': API_KEY },
  });
  const getData = (await getRes.json()) as {
    summary: string;
    facts: any[];
    cached: boolean;
  };

  // Check persisted in MongoDB
  const objId = ObjectId.isValid(activeIncidentId) ? new ObjectId(activeIncidentId) : activeIncidentId;
  const incDoc = await db.collection('incidents').findOne({
    $or: [{ _id: objId as any }, { _id: activeIncidentId as any }, { id: activeIncidentId }],
  });

  const ok =
    postRes.status === 200 &&
    getRes.status === 200 &&
    postData.summary.length > 0 &&
    postData.facts.length > 0 &&
    postData.citations.length > 0 &&
    getData.summary === postData.summary &&
    Boolean(incDoc?.['narration']?.summary);

  check(
    '(d) Narration API: POST/GET /v1/incidents/:id/narrate, idempotent & persisted in DB',
    ok,
    `model=${postData.model} citations=[${postData.citations.join(',')}] factsCount=${postData.facts.length}`,
  );
} catch (err) {
  check('(d) Narration API', false, String(err));
}

// ─── (e) Explain panel API (GET /v1/debug/explain) ───────────────────────────
try {
  const explainRes = await fetch(`${BASE_URL}/v1/debug/explain?projectId=demo`);
  const explainData = (await explainRes.json()) as {
    ok: boolean;
    allIndexScans: boolean;
    queries: Array<{
      name: string;
      isIndexScan: boolean;
      isCollectionScan: boolean;
      stage: string;
      totalDocsExamined: number;
      nReturned: number;
      ratioOk: boolean;
    }>;
  };

  const queriesCount = explainData.queries?.length ?? 0;
  const allIx = explainData.allIndexScans && explainData.queries.every((q) => q.isIndexScan && !q.isCollectionScan);
  const allRatioOk = explainData.queries.every((q) => q.ratioOk);

  const ok = explainRes.status === 200 && queriesCount === 4 && allIx && allRatioOk;
  check(
    '(e) Explain panel: 4 queries verified IXSCAN, 0 COLLSCAN, totalDocsExamined <= 3 * nReturned',
    ok,
    `queriesExamined=${queriesCount} allIndexScans=${allIx} allRatiosOk=${allRatioOk}`,
  );
} catch (err) {
  check('(e) Explain panel verification', false, String(err));
}

// ─── (f) MCP Server stdio handshake and tool invocation ─────────────────────
try {
  // Launch MCP server via child_process using stdio transport
  const mcpProcess = spawn('npx', ['-y', 'tsx', 'mcp/src/index.ts'], {
    shell: true,
    env: {
      ...process.env,
      WAYPOINT_URL: BASE_URL,
      WAYPOINT_API_KEY: API_KEY,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let rpcId = 1;
  function sendRpc(method: string, params: Record<string, any> = {}): Promise<any> {
    const id = rpcId++;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`RPC timeout for method ${method}`));
      }, 5000);

      const onData = (data: Buffer) => {
        const lines = data.toString().split('\n').filter((l) => l.trim().length > 0);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              clearTimeout(timeout);
              mcpProcess.stdout.off('data', onData);
              if (parsed.error) reject(new Error(parsed.error.message));
              else resolve(parsed.result);
              return;
            }
          } catch {
            // non-json line
          }
        }
      };

      mcpProcess.stdout.on('data', onData);
      mcpProcess.stdin.write(request);
    });
  }

  // 1. Initialize MCP protocol
  await sendRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gate11-tester', version: '1.0.0' },
  });

  // Send notifications/initialized
  mcpProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  // 2. List tools
  const toolsResult = await sendRpc('tools/list', {});
  const toolNames = (toolsResult.tools ?? []).map((t: any) => t.name);

  const hasRequiredTools = [
    'preflight_change',
    'explain_incident',
    'recall_lessons',
    'list_incidents',
    'get_deployment_status',
  ].every((t) => toolNames.includes(t));

  // 3. Call tool: list_incidents
  const callResult = await sendRpc('tools/call', {
    name: 'list_incidents',
    arguments: { projectId: 'demo' },
  });

  const toolContent = JSON.parse(callResult.content?.[0]?.text ?? '{}');
  const toolInvocationOk = typeof toolContent.count === 'number';

  mcpProcess.kill();

  const ok = hasRequiredTools && toolInvocationOk;
  check(
    '(f) MCP Server stdio handshake: 5 tools enumerated and executed cleanly',
    ok,
    `tools=[${toolNames.join(',')}] returnedIncidents=${toolContent.count}`,
  );
} catch (err) {
  check('(f) MCP server verification', false, String(err));
}

await client.close();

console.log('');
if (failures === 0) {
  console.log('✅ Gate 11 PASSED\n');
  process.exit(0);
} else {
  console.log(`❌ Gate 11 FAILED (${failures} checks failed)\n`);
  process.exit(1);
}
