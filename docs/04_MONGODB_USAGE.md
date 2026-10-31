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

- **Local:** the MongoDB Atlas local image in Docker (replica set with search and vector search), so the whole stack runs on a laptop.
- **Production:** MongoDB Atlas free tier (M0). It allows a limited number of search and vector indexes in total, so we use two (lesson vector and lesson text) and keep one spare.
- The code is identical in both. Only the connection string and a few environment variables differ.

## 5. Planned MongoDB additions
- An `explain()` panel in the UI showing which index each diagnosis query used
- Time series storage for per-version metrics
- A graph lookup for "which consumers does this change reach", once a consumer map exists
- An MCP server so coding agents can query the same history before they deploy
