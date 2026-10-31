# Waypoint — CONTEXT.md
# Updated after every task. Read first on every session.

---

## Idea

Waypoint records software run histories into MongoDB, detects silent failures
(HTTP-200-but-wrong outcomes) caused by changes in model/prompt/config, finds the
culprit change by replay experiments, remembers lessons, and warns before the next
change.

Detection is **deterministic code + MongoDB aggregations**.
The LLM only narrates a small, pre-computed summary. It never finds root causes.

The demo agent is **simulated** and is labeled as such in the README.

---

## Scope

| Feature | Prompt | Status |
|---|---|---|
| Scaffold + Docker Mongo + env config | 1 | ✅ Done |
| DB init: collections, validators, indexes | 2 | ✅ Done |
| Ingest API (POST /v1/events, GET /v1/runs/:runId/events) | 3 | ✅ Done |
| Production deploy, /health vs Atlas | 4 | ⬜ Pending |
| Content-hashed contexts + derived diff | 5 | ✅ Done |
| Simulated invoice agent + SDK | 6 | ✅ Done |
| Contract mining + violations | 7 | ⬜ Pending |
| Live dashboard via change stream | 8 | ⬜ Pending |
| Freeze-replay grid + statistics | 9 | ⬜ Pending |
| Structural trace diff | 10 | ⬜ Pending |
| Lessons, embeddings, vector search, preflight | 11 | ⬜ Pending |
| LLM narration (compact summary) | 12 | ⬜ Pending |
| MCP server | 13 | ⬜ Pending |
| Hard cases, benchmark, explain() panel | 14 | ⬜ Pending |
| README, video, PPT, freeze checklist | 15 | ⬜ Pending |

---

## Architecture

```
Client / demo agent
      │  POST /v1/events  (x-api-key auth, Zod validation, redaction)
      ▼
  Fastify server  (server/)
      │  insertMany ordered:false → events collection
      ▼
  MongoDB  (atlas-local container locally / Atlas M0 in prod)
      │  Change streams → realtime UI
      │  Aggregations → violation detection
      ▼
  React dashboard  (web/)       MCP server  (mcp-server/)
```

**Single-node replica set** (required for change streams + transactions).
Connection string: `mongodb://localhost:27017/?directConnection=true` (local).

---

## Env Vars

| Variable | Purpose | Set in |
|---|---|---|
| `NODE_ENV` | Runtime environment | `.env` / host |
| `PORT` | Fastify listen port | `.env` / host |
| `LOG_LEVEL` | Pino log level | `.env` / host |
| `CORS_ORIGIN` | Allowed CORS origin | `.env` / host |
| `PUBLIC_URL` | Externally reachable base URL | `.env` / host |
| `MONGODB_URI` | MongoDB connection string | `.env` / host |
| `MONGODB_DB` | Database name | `.env` / host |
| `API_KEYS` | Comma-list of write-route API keys | `.env` / host |
| `LLM_ENABLED` | Enable LLM narration | `.env` / host |
| `LLM_BASE_URL` | OpenAI-compatible endpoint | `.env` / host |
| `LLM_API_KEY` | LLM API key (optional for Ollama) | `.env` / host |
| `LLM_MODEL` | Model name | `.env` / host |
| `EMBED_PROVIDER` | `voyage` \| `ollama` \| `none` | `.env` / host |
| `EMBED_BASE_URL` | Embedding endpoint | `.env` / host |
| `EMBED_API_KEY` | Voyage AI key | `.env` / host |
| `EMBED_MODEL` | Embedding model name | `.env` / host |
| `EMBED_DIM` | Embedding dimension (default 1024) | `.env` / host |
| `WORKER_ENABLED` | Enable background worker | `.env` / host |

---

## Key Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | `mongodb/mongodb-atlas-local:8.0.16-20261014T135244Z` | Pinned tag; ships mongot for Atlas Search + Vector Search |
| D2 | `directConnection=true` in local URI | Required for single-node replica set to enable change streams |
| D3 | `insertMany({ ordered: false })` | Lets valid docs in a batch land even when duplicates exist |
| D4 | Code 11000 → `duplicate_ignored`, not 500 | Idempotent ingestion design |
| D5 | Redaction before insert (not at read time) | Secrets never hit the DB; simpler read path |
| D6 | `collMod` when collection exists | Keeps validators current without dropping data |
| D7 | Atlas M0 limit 3 search indexes; we use 2 | `lessons_vector` + `lessons_text`; third reserved |
| D8 | `initDb()` called on every server boot | Safe because all operations are idempotent |
| D9 | CONTEXT.md generated from standard headings | Saves tokens; self-contained |

---

## Status Checklist

- [x] Gate 0: RULES.md, CONTEXT.md, .env.example exist
- [x] Gate 1: Mongo ping, rs status, change stream, vector index, /health  ✅ 2026-10-31
- [x] Gate 2: initDb ×2 idempotent; valid insert, dup 11000, missing-ts 121, contextPayload variants  ✅ 2026-10-31
- [x] Gate 3: 6 ingest API checks pass  ✅ 2026-10-31
- [ ] Gate 4: Production deploy against Atlas M0 (config & gate ready, awaiting host deployment)
- [x] Gate 5: Content-hashed contexts & derived diff (6 checks pass)  ✅ 2026-10-31
- [x] Gate 6: Simulated agent, corpus & SDK (7 checks pass)  ✅ 2026-10-31

---

## Error Log

| Error | Hypothesis | Fix | Status |
|---|---|---|---|
| `getDb is not defined` at server startup | `getDb` not imported in `index.ts` | Added `getDb` to import from `./db/client.js` | ✅ Fixed |
| `pino-pretty` transport error at startup | `pino-pretty` not in dependencies | `pnpm add pino-pretty` in server package | ✅ Fixed |
| Gate 1 (d): collection does not exist | `createSearchIndex` needs existing collection | Insert seed doc before calling `createSearchIndex` | ✅ Fixed |
| Gate 1 (d): results=0 despite READY | Vector doc inserted after index built; not indexed | Moved seed insert (with `v` field) to before index creation | ✅ Fixed |
| `insertMany` type incompatibility with string `_id` | Mismatch with MongoDB's default `ObjectId` type | Typed collection with `StoredEvent` interface having `_id: string` | ✅ Fixed |

---

## Third-Party

See [THIRD_PARTY.md](./THIRD_PARTY.md) for full license audit.

Key runtime dependencies:
- `fastify@5` — MIT
- `zod@3` — MIT
- `mongodb@6` — Apache-2.0
- `@fastify/cors` — MIT
- `pino-pretty` — MIT
- `diff@9` — BSD-3-Clause
- `tsx` — MIT
- `vitest@2` — MIT

---

## Next Step

**Prompt 7: Contract mining, violations, and change-stream detector**
- Gates 5 & 6 are complete and passed.
- Production deployment (Gate 4) is ready for live host trigger.
