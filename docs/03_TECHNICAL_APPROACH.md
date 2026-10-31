# Technical Approach

## 1. Design principles

1. **Detection is deterministic.** Code and database queries decide what is wrong. An AI model never decides root causes.
2. **Compare rules and rates, not exact text.** AI output varies, so we check invariants over many runs.
3. **Be honest about uncertainty.** "No baseline yet", "inconclusive" and "sampled" are first-class results.
4. **Idempotent everywhere.** Repeating any write is safe.
5. **Configuration only through environment variables.** The same code runs locally and in production.

## 2. Architecture

```
 App or demo agent ──(SDK / POST /v1/events)──►  Fastify server
                                                    │ validate, redact secrets, idempotent insert
                                                    ▼
                                               MongoDB
   events · runs · contexts · contracts · incidents · experiments · replayCache · lessons · meta
                                                    │
              ┌──────────── change streams ─────────┤
              ▼                                     ▼
        Incident detector                    Live stream (SSE)
        (violation rate window)                     │
              │                                     ▼
              ▼                               React dashboard
        Replay engine ──► Shapley + statistics
              │
              ▼
        Lessons (embeddings, hybrid recall) ──► Preflight check
```

Stack: Node 22, TypeScript, Fastify, zod, the official MongoDB driver, React with Vite. One container serves the API and the built web app from a single URL.

## 3. Data flow, step by step

### 3.1 Ingest
- `POST /v1/events` accepts one event or a batch (maximum 500, 1 MB).
- Each event has a stable ID, so retries and duplicates are ignored safely.
- Invalid events get a precise `422` error. Valid events in the same batch still land.
- Secrets (API keys, tokens, passwords) are masked **before** storage.
- Events can arrive out of order. Reads sort by sequence number.

### 3.2 Versioned context
- A **context** is the model, prompt text, settings, tool definitions and dependency versions.
- It is converted to canonical JSON (sorted keys), then hashed with SHA-256. The hash is the version ID.
- A different hash means a different version, so **changes are discovered automatically**, never self-reported.
- A typed diff lists exactly what differs: model, prompt lines, setting keys, tool schema fields, dependencies.

### 3.3 Contract mining
- Pick a **baseline**: a version with at least a minimum number of clean runs.
- A MongoDB aggregation counts which tool-call argument keys appear in what share of runs.
- A key becomes **required** only if it appears in at least 98 percent of baseline runs. A key present in 96 percent is deliberately not required.
- Without enough baseline runs, the answer is `no_baseline_yet` and nothing is flagged.

### 3.4 Violation checking
- When a run ends, its events are checked against the contracts.
- Rule types: missing required key, wrong type, and a similar key present instead (for example `invoice_id` where `invoiceId` was expected).
- Violations are stored on the run.

### 3.5 Incident detector
- A change stream on `runs` feeds a sliding window of the latest completed runs per version.
- An incident opens when the violation rate passes a threshold with enough runs. A unique partial index guarantees one open incident per version.
- The change-stream resume token is stored in MongoDB, so a restart misses nothing.

### 3.6 Replay and culprit analysis
- The diff between baseline and bad version is grouped into **units** (model, prompt as one unit, each setting key, and so on).
- For *k* units, Waypoint builds every coalition (2^k) where only the chosen units come from the bad version, and replays the same input set on each.
- The **same contract checker** used in production is the pass/fail test, so replay and live detection agree.
- Replay writes only to `experiments`, never to `runs` or `events`, so it cannot trigger false incidents.
- Results are cached by (version, input, seed, agent version), so repeating an experiment costs no new agent calls.

### 3.7 Statistics
- **Wilson 95 percent interval** on each coalition's violation rate.
- Verdicts: **failing** (lower bound clearly above baseline), **ok** (within tolerance), **inconclusive** (not enough evidence).
- **Shapley values** share blame fairly across units. They always add up to the total effect.
  - Formula: each unit's value is the average of its marginal contribution over all orders in which units could be added.
  - Exact for up to 4 units. For more units, Monte Carlo permutation sampling is used and labeled `sampled`.
- **Interaction score** shows whether two units fail only together.
- **Bootstrap intervals** on Shapley values by resampling inputs.
- Caveat shown everywhere: Shapley is credit assignment over replay results, not proof of causation.

### 3.8 Lessons and recall
- Resolving an incident creates one lesson: symptom, culprit units, change types, fix.
- The lesson is embedded as a vector and also indexed as text.
- Recall filters by project and by active status, hides expired or corrected lessons at query time, and drops weak matches. "No prior incident" is a valid answer.
- Exact tokens such as `invoice_id` match through the text path.
- A small evaluation set (paraphrases, exact tokens and negative queries) measures hit rate and false matches.

### 3.9 Preflight check
1. Diff the live version against the proposed version.
2. Replay the input set on the proposed version.
3. Recall similar lessons.
4. Verdict: **block** (clearly worse), **warn** (matching lesson or inconclusive), or **pass**.
5. Return reasons and a short plain-text summary.

### 3.10 Dashboard and live updates
- A server-sent events stream is backed by MongoDB change streams.
- The browser never holds an API key. Scenario buttons call server-side routes with their own key and rate limit.

## 4. Where AI is used (and not used)

| Task | Done by |
|---|---|
| Detecting violations | Code and aggregations |
| Finding changes | Hash comparison and diff |
| Blame sharing | Replay and Shapley math |
| Similar past incidents | Vector and text search |
| Writing a readable explanation (planned) | Optional language model, from a short precomputed summary |

The language model receives roughly 300 to 500 tokens of computed facts, never raw logs.

## 5. Reliability and safety
- Strict input validation at every boundary
- API key on write routes, body size limits, rate limiting on public demo routes
- Graceful shutdown and resume after restart
- No leftover "running" experiments after a restart
- Secrets never logged or stored

## 6. Testing approach
Every stage has a **gate script** that must pass with real output before moving on. Gates include concurrency (200 parallel identical writes give one document), false-positive checks (clean runs give zero violations), statistical correctness (Shapley values sum exactly to the total effect), and isolation (replay writes nothing to live data).

## 7. Configuration and deployment
- All environment-specific values come from `.env` (local) or host variables (production).
- Local: Docker Compose with a MongoDB image that includes search.
- Production: one container on an always-on host plus MongoDB Atlas.
- Change streams need a long-running process, so serverless hosting is not used.
