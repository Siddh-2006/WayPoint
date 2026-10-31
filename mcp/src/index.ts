#!/usr/bin/env node
/**
 * mcp/src/index.ts
 *
 * Model Context Protocol (MCP) server for Waypoint.
 * Exposes read-only tools over standard input/output (stdio) for coding agents
 * (Claude Desktop, Cursor, Antigravity, etc.) to perform safety checks:
 *   1. preflight_change     - Evaluates proposed context changes before shipping
 *   2. explain_incident    - Returns incident root causes, Shapley attribution & narration
 *   3. recall_lessons      - Recalls prior episodic memories and fixes for symptoms
 *   4. list_incidents      - Lists active or resolved regressions
 *   5. get_deployment_status - Returns baseline context fingerprint and contract health
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const WAYPOINT_URL = process.env['WAYPOINT_URL'] ?? 'http://127.0.0.1:3000';
const WAYPOINT_API_KEY = process.env['WAYPOINT_API_KEY'] ?? process.env['API_KEY'] ?? 'test-key-1';

const server = new McpServer({
  name: 'waypoint-mcp',
  version: '0.1.0',
});

// Helper for making API calls to Waypoint server
async function fetchWaypoint(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${WAYPOINT_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': WAYPOINT_API_KEY,
    ...(options.headers as Record<string, string>),
  };

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Waypoint API error (${res.status}): ${errorBody}`);
  }
  return res.json();
}

// ─── Tool 1: preflight_change ────────────────────────────────────────────────
server.tool(
  'preflight_change',
  'Diff a proposed model/prompt/config context against production baseline and simulate replay before deploying',
  {
    projectId: z.string().describe('Target project ID (e.g. "demo")'),
    proposedContext: z
      .record(z.any())
      .describe('Proposed context containing model, promptText, config, toolSchemas, deps'),
  },
  async ({ projectId, proposedContext }) => {
    try {
      const data = await fetchWaypoint('/v1/preflight', {
        method: 'POST',
        body: JSON.stringify({ projectId, proposedContext }),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                verdict: data.verdict,
                summary: data.summary,
                reasons: data.reasons,
                replayStats: data.replay,
                matchedLessonsCount: data.matchedLessons?.length ?? 0,
                matchedLessons: data.matchedLessons,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Preflight check failed: ${err.message}` }],
      };
    }
  },
);

// ─── Tool 2: explain_incident ────────────────────────────────────────────────
server.tool(
  'explain_incident',
  'Explain an incident root cause with Shapley attribution, evidence run citations, and narration',
  {
    incidentId: z.string().describe('Incident identifier or MongoDB ObjectId'),
  },
  async ({ incidentId }) => {
    try {
      const incident = await fetchWaypoint(`/v1/incidents/${incidentId}`);
      let narration = incident.narration;

      if (!narration) {
        try {
          narration = await fetchWaypoint(`/v1/incidents/${incidentId}/narrate`, {
            method: 'POST',
            body: JSON.stringify({ forceRefresh: false }),
          });
        } catch {
          // Non-fatal if narrate fails
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                id: incident.id,
                projectId: incident.projectId,
                rate: incident.rate,
                status: incident.status,
                badHash: incident.badHash,
                baselineHash: incident.baselineHash,
                changes: incident.changes,
                violationSummary: incident.violationSummary,
                narration: narration?.summary ?? 'No narrative generated yet',
                facts: narration?.facts ?? [],
                citations: narration?.citations ?? [],
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to explain incident: ${err.message}` }],
      };
    }
  },
);

// ─── Tool 3: recall_lessons ──────────────────────────────────────────────────
server.tool(
  'recall_lessons',
  'Query episodic memory lessons using semantic vector search and keyword retrieval',
  {
    projectId: z.string().describe('Project scope identifier'),
    query: z.string().describe('Search query describing the symptom or configuration change'),
    minScore: z.number().optional().describe('Minimum similarity threshold (default 0.25)'),
    limit: z.number().optional().describe('Maximum lessons to return (default 5)'),
  },
  async ({ projectId, query, minScore, limit }) => {
    try {
      const data = await fetchWaypoint('/v1/lessons/recall', {
        method: 'POST',
        body: JSON.stringify({ projectId, query, minScore, limit }),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                mode: data.mode,
                count: data.count,
                results: data.results.map((r: any) => ({
                  lessonId: r.lessonId,
                  score: r.score,
                  scoreType: r.scoreType,
                  symptom: r.lesson.symptom,
                  fix: r.lesson.fix,
                  culprit: r.lesson.culprit,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Lesson recall failed: ${err.message}` }],
      };
    }
  },
);

// ─── Tool 4: list_incidents ──────────────────────────────────────────────────
server.tool(
  'list_incidents',
  'List recent regression incidents detected across production runs',
  {
    projectId: z.string().optional().describe('Filter by project ID'),
    status: z.enum(['open', 'resolved']).optional().describe('Filter by incident status'),
  },
  async ({ projectId, status }) => {
    try {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      if (status) params.set('status', status);

      const data = await fetchWaypoint(`/v1/incidents?${params.toString()}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: data.incidents?.length ?? 0,
                incidents: (data.incidents ?? []).map((inc: any) => ({
                  id: inc.id ?? inc._id,
                  projectId: inc.projectId,
                  rate: inc.rate,
                  status: inc.status,
                  openedAt: inc.openedAt,
                  badHash: inc.badHash,
                  evidenceCount: inc.evidenceRunIds?.length ?? 0,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to list incidents: ${err.message}` }],
      };
    }
  },
);

// ─── Tool 5: get_deployment_status ───────────────────────────────────────────
server.tool(
  'get_deployment_status',
  'Get the live deployment baseline context and contract health for a project',
  {
    projectId: z.string().describe('Target project ID'),
  },
  async ({ projectId }) => {
    try {
      const contractsData = await fetchWaypoint(`/v1/projects/${projectId}/contracts`);
      const incidentsData = await fetchWaypoint(`/v1/incidents?projectId=${projectId}&status=open`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                projectId,
                contractsCount: contractsData.contracts?.length ?? 0,
                contracts: contractsData.contracts,
                openIncidentsCount: incidentsData.incidents?.length ?? 0,
                status: (incidentsData.incidents?.length ?? 0) === 0 ? 'healthy' : 'degraded',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to get deployment status: ${err.message}` }],
      };
    }
  },
);

// ─── Start STDIO Transport ───────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Waypoint MCP Server encountered fatal error:', err);
  process.exit(1);
});
