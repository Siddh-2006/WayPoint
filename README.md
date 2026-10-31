# Waypoint

> **A flight recorder for software changes.**  
> Waypoint records run histories into MongoDB, detects silent failures (HTTP-200-but-wrong outcomes) caused by invisible changes (model, prompt, configuration, tools, dependencies), isolates the culprit change via factorial replay experiments and Shapley attribution, remembers past fixes as episodic memory lessons, and warns before future regressions.

---

## Architecture at a Glance

```
  App / Simulated Agent ──(SDK / POST /v1/events)──► Fastify Server
                                                        │ Validate & redact
                                                        ▼
                                                   MongoDB (Atlas)
       events · runs · contexts · contracts · incidents · experiments · lessons
                                                        │
                 ┌───────────── Change Streams ─────────┤
                 ▼                                      ▼
           Incident Detector                    Live SSE Stream
       (violation rate window)                         │
                 │                                      ▼
                 ▼                               React Dashboard
           Replay Engine ──► Shapley + Statistics
                 │
                 ▼
           Episodic Lessons (Vector + Text RRF) ──► Preflight Regression Guard
```

- **Deterministic Core**: Invariants and violations are detected via deterministic code and MongoDB aggregations (`$match`, `$project`, `$objectToArray`, `$unwind`, `$group`), never by LLM guessing.
- **Fair Blame Sharing**: Game-theoretic Shapley attribution over factorial replay grids with Wilson score confidence intervals and interaction effect detection.
- **Episodic Memory**: Resolved incidents become searchable lessons with hybrid vector cosine and lexical token search via Reciprocal Rank Fusion ($k=60$).
- **Preflight Guard**: Evaluates proposed context diffs against live baselines and historical lessons before deployment (`block`, `warn`, `pass`).
- **Simulated Demo**: Includes an invoice extraction agent with 20 seeded test cases and planted multi-variable regressions (`bad_deploy`), clearly labeled as simulated.

---

## Documentation

Full architectural specifications, problem statements, and implementation references are available in [`docs/`](./docs/):

| Document | Description |
|---|---|
| [**00 Overview**](./docs/00_OVERVIEW.md) | Plain-language summary of Change Amnesia, the 5-step lifecycle, and design choices. |
| [**01 Problems**](./docs/01_PROBLEMS.md) | Ten real-world silent failure scenarios, what Waypoint solves, and explicit non-goals. |
| [**02 Solutions**](./docs/02_SOLUTIONS.md) | How the Record $\to$ Detect $\to$ Explain $\to$ Remember $\to$ Warn pipeline solves each problem. |
| [**03 Technical Approach**](./docs/03_TECHNICAL_APPROACH.md) | System architecture, content-hashed contexts, Shapley mathematics, and reliability engineering. |
| [**04 MongoDB Usage**](./docs/04_MONGODB_USAGE.md) | Complete breakdown of MongoDB features used: flexible schemas, change streams, aggregations, vector search, TTL, and partial unique indexes. |
| [**05 Features**](./docs/05_FEATURES.md) | Feature-by-feature status breakdown: Built (1–8) and Planned (9–11). |

---

## Quick Start

### 1. Prerequisites
- Node.js 22+
- pnpm 9+
- Docker Desktop (for local MongoDB replica set with vector search)

### 2. Setup & Installation
```bash
# Clone the repository
git clone https://github.com/Siddh-2006/WayPoint.git
cd WayPoint

# Install dependencies
pnpm install

# Start local MongoDB replica set with Atlas Search
docker compose up -d

# Initialize database collections, validators, and indexes
pnpm db:init
```

### 3. Run Development Servers
```bash
# Start backend API (Fastify on port 3000)
pnpm dev

# In another terminal, start React Dashboard (Vite on port 5173)
pnpm --filter @waypoint/web dev
```

### 4. Verification Gates
Waypoint enforces automated gate scripts across every development milestone:
```bash
pnpm gate:1   # MongoDB schema & vector index probe
pnpm gate:2   # Collections, schemas & uniqueness constraints
pnpm gate:3   # Event ingestion & deduplication
pnpm gate:5   # Context hashing & derived diffs
pnpm gate:6   # Simulated agent & SDK
pnpm gate:7   # Contract mining & incident detection
pnpm gate:8   # React dashboard & SSE change streams
pnpm gate:9   # Factorial replay grid & Shapley attribution (precision <= 1e-15)
pnpm gate:10  # Episodic memory lessons, hybrid recall & preflight guard
pnpm gate:10b # Real vector recall, honest score typing & hard paraphrase evaluation
pnpm gate:11  # Evidence-cited LLM narration, MCP server & query explain panel
pnpm gate:11e # Episodic memory calibration (split n=24), UI match tiering & Voyage rate limit resilience
pnpm gate:11f # Product-aligned strong-tier recall (held-out n=12), realistic preflight & client RPM pacing
pnpm gate:11g # Realistic preflight test, threshold provenance & weak match formatting
pnpm gate:11h # Meaningful preflight matching: violation-based recall query & structural match
```

### 5. Episodic Memory Recall & Calibration ($n=24$)
- **Evaluation Set**: Small benchmark of $n=24$ queries (12 calibration, 12 held-out) against 8 seeded lessons using official MongoDB Atlas Voyage-4 embeddings (1024-dim).
- **Threshold Provenance**: Threshold `0.48` was chosen on 12 calibration queries, checked on 12 held-out (note: $n$ is small).
- **Evaluation Summary**: "On a small evaluation (24 queries, 12 held out), vector search ranked the correct past incident first on every paraphrased query where keyword search found nothing. We set a conservative warning threshold, so weaker matches appear as context and don’t trigger a warning. Our false-warning rate on the held-out set was 0 of 5."
- **Held-Out Results**: Strong-tier Hit@1 = 57% (4/7), Strong-tier Hit@3 = 57% (4/7), Negative False-Warning Rate = 0% (0/5). Pure rank-based Hit@3 without threshold cutoff is 100%.

### 6. Two-Signal Preflight Matching
Preflight lesson matching uses two complementary signals:

1. **Semantic signal (violation-based query)**: When replay produces violations, the recall query is built from violation messages — the same vocabulary as the lesson's stored `symptom`. This ensures like-for-like semantic comparison (cosine ~0.88 on exact reoccurrences vs ~0.45 from a diff-description query). When replay is clean, the query falls back to change summaries.

2. **Structural signal (deterministic, no threshold)**: A lesson is a strong structural match when its `violatedRules` contains `(rule, expectedKey)` matching a replay violation, AND the proposal's changed axes overlap the lesson's `culprit.units`. Both signals and cosine scores are shown in preflight reasons, making the match fully auditable.

> **SIMULATED behavior note**: The demo invoice agent's snake_case `invoice_id` bug is deliberately planted. It triggers on models `v2` and `v3` when the camelCase prompt guard (`"Always use camelCase keys"`) is absent. This is documented in `server/src/demo/invoice-agent.ts`. The `v3` behavior enables a realistic demo: a model bump to `v3` is blocked because the same rule violation reoccurs and is matched structurally to the saved lesson.

### 7. Model Context Protocol (MCP) Server
Waypoint includes a standard I/O (stdio) MCP server allowing coding agents in Claude Desktop, Cursor, and Antigravity to run preflight verification and query lessons autonomously. See [docs/MCP.md](docs/MCP.md).

---

## License & Credits

- MIT License. See [LICENSE](./LICENSE) and [THIRD_PARTY.md](./THIRD_PARTY.md) for full license audit of open-source libraries.

