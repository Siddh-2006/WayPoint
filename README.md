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
```

---

## License & Credits

- MIT License. See [LICENSE](./LICENSE) and [THIRD_PARTY.md](./THIRD_PARTY.md) for full license audit of open-source libraries.
