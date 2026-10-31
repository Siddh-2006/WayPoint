# WayPoint — Project Rules

## 0 — Governing Principle

This project is an original TypeScript work.  
External code is only borrowed when the license explicitly permits it.

---

## 1 — Intellectual-Property Rules (Non-Negotiable)

### 1.1 Permitted reuse

| SPDX identifier | Can copy code? | Obligation |
|---|---|---|
| MIT | ✅ Yes | Keep `LICENSE` file; log it in `THIRD_PARTY.md` |
| Apache-2.0 | ✅ Yes | Keep `LICENSE` + `NOTICE`; log in `THIRD_PARTY.md` |
| BSD-2-Clause / BSD-3-Clause | ✅ Yes | Keep copyright header; log in `THIRD_PARTY.md` |
| ISC | ✅ Yes | Keep copyright header; log in `THIRD_PARTY.md` |
| GPL / AGPL (any version) | ❌ No | Study architecture only; write your own |
| No license stated | ❌ No | Treat as all-rights-reserved |

### 1.2 Reference-only projects

The following projects are **design references only** — their source code must NOT be copied, cloned, or adapted:

| Project | Reason |
|---|---|
| Shadow | Wrong stack (Rust) |
| Sornaris | Wrong stack (Python) |

Study their architecture diagrams, README ideas, and API shapes.  
Implement everything from scratch in TypeScript.

### 1.3 What is plagiarism here

- Copying code and then rewording it to hide the source.
- Cloning a GPL/no-license repo and "translating" it to another language.
- Using a snippet without crediting it in `THIRD_PARTY.md`.

**If unsure: don't copy. Write your own.**

### 1.4 THIRD_PARTY.md log format

Every dependency or snippet that required a license check must have an entry:

```
## <package-name> <version>
License : <SPDX>
Source  : <URL>
Usage   : <one sentence>
Verified: <ISO date> by <agent or human>
```

---

## 2 — Approved Technology Stack

| Layer | Choice |
|---|---|
| Runtime | Node 22 |
| Package manager | pnpm |
| Language | TypeScript (strict mode) |
| HTTP server | Fastify |
| Validation | Zod |
| Database | MongoDB (Atlas M0 in prod, replica-set container locally) |
| Diff | jsondiffpatch |
| Statistics | simple-statistics |
| MCP SDK | @modelcontextprotocol/sdk |
| UI | React + MIT-licensed dashboard template |
| Container | Docker Desktop / docker compose |
| Embeddings | Voyage AI (EMBED_API_KEY) |
| Local LLM | Ollama (Qwen or Gemma) |
| Production LLM | Groq or Gemini (optional) |

No other runtime dependencies may be added without updating this file.

---

## 3 — Secrets Management

| Location | Rule |
|---|---|
| `.env` | Local only. **NEVER commit.** |
| Host environment variables | Production secrets (Render / Fly / Railway) |
| `.env.example` | Committed. All keys present, all values empty or placeholder |
| `THIRD_PARTY.md` | Committed. License audit trail |

**Never** put a real key in:
- Any committed file
- README, CONTEXT.md, PPT, or demo video

---

## 4 — Code Quality Gates

Each prompt has a named gate. No prompt is considered complete until its gate passes:

| Prompt | Gate |
|---|---|
| 0 | `RULES.md`, `CONTEXT.md`, `.env.example` exist |
| 1 | Mongo ping, replica set, change stream, vector index all respond |
| 2 | Idempotent init; duplicates and invalid docs rejected |
| 3 | 1,000 concurrent duplicate ingestions → 1 doc; invalid → 422 |
| 4 | Public URL `/health` responds against Atlas M0 |
| 5 | Same input → same content hash; diff correct |
| 6 | Good and bad agent scenarios reproducible |
| 7 | Planted bug flagged; clean run not flagged |
| 8 | Event in UI within 2 seconds of DB write |
| 9 | Planted interaction culprit found in freeze-replay grid |
| 10 | First divergence step identified correctly |
| 11 | Retrieval hit-rate reported against test set |
| 12 | Narration works with local Ollama and remote provider |
| 13 | MCP tool list and calls succeed |
| 14 | All hard-case tests pass; explain() panel renders |
| 15 | Incognito link check passes for README, video, PPT |

---

## 5 — Git Hygiene

- Commit message format: `<scope>(<area>): <what changed>`  
  Example: `feat(ingest): add redaction middleware`
- One logical change per commit.
- `main` branch is always deployable.
- Feature work in `feat/<name>` branches, merged via PR.

---

## 6 — File Layout (target)

```
waypoint/
├── RULES.md
├── CONTEXT.md
├── THIRD_PARTY.md
├── .env.example
├── .env                     ← gitignored
├── docker-compose.yml
├── packages/
│   ├── api/                 ← Fastify server
│   ├── agent-sdk/           ← simulated agent + SDK
│   ├── mcp-server/          ← MCP server
│   └── dashboard/           ← React UI
├── scripts/
│   └── db-init.ts
└── docs/
```
