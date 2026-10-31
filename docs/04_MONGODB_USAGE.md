# How Waypoint Uses MongoDB

Waypoint's data is messy and varied (prompt text, JSON settings, tool calls, vectors) but also needs strict rules (stable IDs, required fields, no duplicates). MongoDB handles both in one database, so there is no separate search system, queue or log store.

## 1. Feature-by-feature

| MongoDB feature | Where it is used | Why it is the right tool |
|---|---|---|
| **Flexible documents** | `contextPayload` in events, `contexts` (model, prompt, settings, tool schemas) | Prompts, settings and tool calls all have different shapes. No table redesign for each source. |
| **Schema validation** (`$jsonSchema`) | `events`, `runs`, `lessons`, and others | Required fields (`eventId`, `ts`, `type`, `status`) are enforced while payloads stay flexible. |
| **Unique indexes** | Event `_id`, run ID, context hash, one lesson per incident, one cached replay result | Makes duplicate delivery and concurrent writes safe. 200 simultaneous identical writes create one document. |
| **Partial unique index** | One open incident per (project, version) | Prevents duplicate incidents while allowing history. |
| **Compound indexes** | `(projectId, runId, seq)`, `(projectId, contextHash, startedAt)` | Built for the questions the tool asks most. |
| **Aggregation pipelines** | Contract mining (`$match`, `$project`, `$objectToArray`, `$unwind`, `$group`) | The detection logic runs inside the database, close to the data. |
| **Change streams** | Incident detector and the live dashboard feed | Reacts the moment a run finishes. No polling. |
| **Resume tokens** (stored in `meta`) | Detector restarts | A restart or crash loses no events. |
| **Vector search** | Lesson recall ("have we seen this before?") | Matches paraphrased symptoms, not just exact words. |
| **Text search** | Lesson recall for exact tokens such as `invoice_id` | Exact error names and keys must still match. |
| **Hybrid recall** | Vector and text results combined by reciprocal rank fusion | Covers both meaning and exact words. Falls back to text-only when embeddings are not configured, and the response says which mode ran. |
| **TTL index** | `lessons.expiresAt` | Old lessons expire automatically. Queries also filter by `expiresAt` because the TTL monitor runs on a delay. |
| **Replica set** | Local Docker and Atlas | Required for change streams. |

## 2. Collections

| Collection | Holds | Key rules |
|---|---|---|
| `events` | Every step of every run | `_id` is the client event ID, unique. Validated. |
| `runs` | One document per run, linked to a context hash, with violations | Unique run ID. |
| `contexts` | Immutable versions (model, prompt, settings, tools, dependencies) | Unique content hash. |
| `deployments` | Which version is live and the baseline version | One per project. |
| `contracts` | Learned rules per tool, with support values | Indexed by project and tool. |
| `incidents` | Detected regressions with evidence | One open per project and version. |
| `experiments` | Replay grids, Shapley values, statistics | Status tracking, no zombie runs after restart. |
| `replayCache` | Memoized replay results | Unique key. Repeats cost nothing. |
| `lessons` | Symptom, culprit, fix, embedding, status, expiry | Unique per incident. Vector, text and TTL indexes. |
| `meta` | Change-stream resume tokens | Small key-value store. |

## 3. Design choices a reviewer may ask about

**Why not store everything as logs?** Logs can't enforce uniqueness, can't be aggregated by rule, and can't power vector recall. A document database with validation can.

**Why one database for everything?** Runs, versions, experiments, lessons and their embeddings are all linked. Keeping them together avoids the synchronization problems of separate vector, search and log systems.

**Why aggregation for mining instead of application code?** The data stays in the database, the logic is a short pipeline, and it scales with indexes instead of with memory.

**Why store the resume token?** A detector that forgets its position after a restart would silently miss failures, which is the exact problem Waypoint exists to prevent.

## 4. Local and production

- **Local:** MongoDB with replica set support in Docker. Embeddings generated via MongoDB Atlas Embedding API (`voyage-4` via Voyage AI) or local Ollama, with vector similarity search running in Atlas or fallback in-memory cosine ranking.
- **Production:** MongoDB Atlas (M0/M10). Uses Atlas Vector Search (`$vectorSearch` on `lessons_vector`) and in-app lexical token-overlap & exact-identifier matching, combined via Reciprocal Rank Fusion (RRF k=60).
- Embeddings are generated client-side via MongoDB's serverless Atlas Embedding & Reranking API (`https://ai.mongodb.com/v1`, using Voyage AI models with 200M free organization tokens).
- **Episodic Memory Calibration & Resilience ($n=24$ eval set):**
  - **Deterministic Split:** Even queries ($n=12$, 7 pos / 5 neg) calibrate threshold; odd queries ($n=12$, 7 pos / 5 neg) serve as strictly held-out test.
  - **Score Normalization:** Atlas Vector Search computes score as $(1 + \cos)/2$; Waypoint normalizes this back to raw cosine $[-1, 1]$ so thresholds remain consistent across Atlas and in-memory execution.
  - **Threshold Calibration:** `LESSON_MIN_SCORE = 0.48` chosen on calibration split to suppress false positives on domain-near negative queries.
  - **UI Tiering:** `score >= 0.48` or exact identifier match gives "strong match" (`similar: true`, triggers Preflight warning). Faint similarity gives "weak match" (`similar: false`, verdict remains `pass`).
  - **Held-Out Strong-Tier Performance ($n=12$):** Strong Hit@1 = 57% (4/7), Strong Hit@3 = 57% (4/7), Negative False-Warning Rate = 0% (0/5). (Rank-only Hit@3 without threshold is 100%).
  - **Rate Limit Resilience:** Official Voyage limits are 3 RPM / 10K TPM on trial, scaling to 2,000 RPM / 3M TPM when billing info is attached (using the 200M free tokens). Waypoint implements `EMBED_MAX_RPM = 3` client-side request pacing, an LRU query cache (`QueryEmbeddingLruCache`), non-blocking startup demo precomputation, and graceful fallback to `text_only` on 429/timeout with note `"semantic search temporarily unavailable"` (never 500).

## 5. Planned MongoDB additions
- An `explain()` panel in the UI showing which index each diagnosis query used
- Time series storage for per-version metrics
- A graph lookup for "which consumers does this change reach", once a consumer map exists
- An MCP server so coding agents can query the same history before they deploy
