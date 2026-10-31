# Model Context Protocol (MCP) Server for Waypoint

Waypoint provides a native **Model Context Protocol (MCP)** server over standard I/O (`stdio`). This allows coding agents in Claude Desktop, Cursor, Antigravity, and CLI agents to autonomously inspect regressions, run preflight simulations, and recall episodic lessons before deploying changes.

---

## Capabilities & Available Tools

The Waypoint MCP server exposes 5 read-only tools:

| Tool | Parameters | Description |
|---|---|---|
| `preflight_change` | `projectId`, `proposedContext` | Diffs proposed model/prompt context against live baseline, runs replay simulation across corpus, recalls matching lessons, and returns safety verdict (`pass`, `warn`, or `block`). |
| `explain_incident` | `incidentId` | Retrieves root cause context diff, Shapley attribution, evidence run citations, and evidence-grounded narration. |
| `recall_lessons` | `projectId`, `query`, `minScore?`, `limit?` | Scoped episodic memory recall using hybrid semantic vector search + keyword retrieval. |
| `list_incidents` | `projectId?`, `status?` | Lists active or resolved regressions with failure rates and evidence run counts. |
| `get_deployment_status` | `projectId` | Returns baseline context fingerprint, active contract invariants, and open incident status. |

---

## Client Configuration

### 1. Claude Desktop

Add the following to your Claude Desktop configuration file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "waypoint": {
      "command": "node",
      "args": ["<PATH_TO_WAYPOINT>/mcp/dist/index.js"],
      "env": {
        "WAYPOINT_URL": "http://127.0.0.1:3000",
        "WAYPOINT_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Or run directly with `tsx`:
```json
{
  "mcpServers": {
    "waypoint": {
      "command": "npx",
      "args": ["-y", "tsx", "<PATH_TO_WAYPOINT>/mcp/src/index.ts"],
      "env": {
        "WAYPOINT_URL": "http://127.0.0.1:3000",
        "WAYPOINT_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

---

### 2. Cursor

Add to your project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "waypoint": {
      "command": "node",
      "args": ["./mcp/dist/index.js"],
      "env": {
        "WAYPOINT_URL": "http://127.0.0.1:3000",
        "WAYPOINT_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

---

### 3. Antigravity / Custom Agent Sidecars

Waypoint can be added to Antigravity's MCP configuration (`~/.gemini/antigravity/mcp_config.json`):

```json
{
  "mcpServers": {
    "waypoint": {
      "command": "node",
      "args": ["E:/WayPoint/mcp/dist/index.js"],
      "env": {
        "WAYPOINT_URL": "http://127.0.0.1:3000",
        "WAYPOINT_API_KEY": "test-key-1"
      }
    }
  }
}
```

---

## Security & Safety Boundaries

1. **Read-Only / Side-Effect Free:**
   All MCP tools are strictly read-only. `preflight_change` performs deterministic replay using `replayCache` and never writes to production `runs` or `events`.
2. **Tenant Scoping:**
   All queries are strictly scoped by `projectId`.
3. **No Secret Leakage:**
   Environment variables, API keys, and sensitive payload tokens are redacted before tool return.
