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
| Contract mining + violations | 7 | ✅ Done |
| Live dashboard via change stream | 8 | ✅ Done |
| Freeze-replay grid + statistics | 9 | ✅ Done |
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
| D10 | Single-service deployment | Fastify serves `web/dist` directly with SPA fallback to eliminate CORS & latency |
| D11 | BSON number type mapping | JS `number` matches `double`, `int`, `long`, `decimal` from Mongo mining |
| D12 | Zero secrets in client browser | Demo triggers execute server-side; 0 client keys |
| D13 | Public read for demo projects | `READ_PUBLIC_PROJECTS` allows guest UI viewing without key exposure |
| D14 | Generic change units & pure applyUnits | Engine never hardcodes units; derives from context diff |
| D15 | Honest statistics with Wilson intervals | Overlapping bounds yield "inconclusive" verdict rather than speculation |
| D16 | Replay isolation | Replay writes 0 documents to runs/events; 0 fake incidents |
| D17 | Replay cache memoization | Unique keys in `replayCache` guarantee 0 new agent calls on repeated experiments |
| D18 | Full-stack Docker image | Multi-stage build compiles `web` and `server`, serving SPA directly |

---

## Status Checklist

- [x] Gate 0: RULES.md, CONTEXT.md, .env.example exist
- [x] Gate 1: Mongo ping, rs status, change stream, vector index, /health  ✅ 2026-10-31
- [x] Gate 2: initDb ×2 idempotent; valid insert, dup 11000, missing-ts 121, contextPayload variants  ✅ 2026-10-31
- [x] Gate 3: 6 ingest API checks pass  ✅ 2026-10-31
- [ ] Gate 4: Production deploy against Atlas M0 (config & gate ready, awaiting host deployment)
- [x] Gate 5: Content-hashed contexts & derived diff (6 checks pass)  ✅ 2026-10-31
- [x] Gate 6: Simulated agent, corpus & SDK (7 checks pass)  ✅ 2026-10-31
- [x] Gate 7: Contract mining, violations & detector (8 checks pass)  ✅ 2026-10-31
- [x] Gate 8: React dashboard & Live SSE stream (5 checks pass)  ✅ 2026-10-31
- [x] Gate 9: Factorial replay grid & Shapley attribution (11 checks pass)  ✅ 2026-10-31

---

## Error Log

| Error | Hypothesis | Fix | Status |
|---|---|---|---|
| `getDb is not defined` at server startup | `getDb` not imported in `index.ts` | Added `getDb` to import from `./db/client.js` | ✅ Fixed |
| `pino-pretty` transport error at startup | `pino-pretty` not in dependencies | `pnpm add pino-pretty` in server package | ✅ Fixed |
| Gate 1 (d): collection does not exist | `createSearchIndex` needs existing collection | Insert seed doc before calling `createSearchIndex` | ✅ Fixed |
| Gate 1 (d): results=0 despite READY | Vector doc inserted after index built; not indexed | Moved seed insert (with `v` field) to before index creation | ✅ Fixed |
| `insertMany` type incompatibility with string `_id` | Mismatch with MongoDB's default `ObjectId` type | Typed collection with `StoredEvent` interface having `_id: string` | ✅ Fixed |
| Schema 121 error on `deployments` upsert | `rev` required integer in validator | Made `rev` optional on upsert, added `$setOnInsert: { rev: 1 }` | ✅ Fixed |
| Gate 7 false positives on fresh runs | JS `number` was rejected by BSON `double` contract type | Mapped JS `number` to accept `double`, `int`, `long`, `decimal` | ✅ Fixed |
| Gate 8 secret in bundle audit | Hardcoded API key in client component | Removed client key; execute runs server-side via `/v1/demo/run` | ✅ Fixed |
| Fastify empty body error on POST replay | Fastify 5 rejects empty body with Content-Type application/json | Passed `{}` body in POST replay calls | ✅ Fixed |
| Number(input.id) yielded NaN | Invoice IDs are alphanumeric ('INV-2026-001') | Parsed integer digits from ID string | ✅ Fixed |

---

## Third-Party

See [THIRD_PARTY.md](./THIRD_PARTY.md) for full license audit.

Key runtime dependencies:
- `fastify@5` — MIT
- `zod@3` — MIT
- `mongodb@6` — Apache-2.0
- `@fastify/cors` — MIT
- `@fastify/static` — MIT
- `pino-pretty` — MIT
- `diff@9` — BSD-3-Clause
- `react@18` — MIT
- `recharts@2` — MIT
- `lucide-react` — ISC
- `@tanstack/react-query` — MIT
- `tsx` — MIT
- `vitest@2` — MIT

---

## Next Step

**Prompt 10: Structural trace diff**
- Trace alignment and step-by-step divergence localization.
- Finding the exact step and tool call where a good run and a failing run bifurcate.
