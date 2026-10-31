# Waypoint — Failure Attribution & Episodic Preflight Guard for LLM Agents

Waypoint is a flight recorder and regression guard for AI agents. When a production agent silently breaks (returning HTTP 200 while emitting corrupted tool calls or invalid schemas), Waypoint answers three critical questions:
1. **What changed?** Content-hashed context snapshots pinpoint exact diffs in model, system prompt, tool schemas, and configurations.
2. **Which change caused the breakage?** Factorial replay experiments evaluate every subset of changes across test inputs, computing Shapley blame shares to isolate culprits even when model and prompt changes interact.
3. **Have we seen this before?** Episodic memory recalls past incident resolutions using semantic vector search and lexical token matching. When a developer proposes a new deploy, preflight rechecks the change and stops repeat mistakes before they reach production.

---

## 1. Live Demo & How to Test in 3 Minutes

- **Live URL**: `https://waypoint-production-c529.up.railway.app` *(or your active deployment URL)*
- **Local Dashboard**: `http://localhost:3000/guide`
- **Authentication**: **No login required.** Every visitor receives an isolated per-session sandbox (`demo-<uuid>`).

### The 3-Minute Test Path (Interactive Demo Story)

Open **`/guide`** in your browser and click through steps 1 to 6:

1. **Step 1: Reset Sandbox**  
   *What it does*: Creates a clean, isolated project sandbox (`demo-...`) and seeds 12 baseline runs.  
   *What you see*: Success badge: `Sandbox reset! Seeded 12 baseline runs`.

2. **Step 2: Run Baseline**  
   *What it does*: Executes 20 invoice extraction runs using model `v1` and a strict camelCase prompt rule. Mines structural invariants (`invoiceId` string required).  
   *What you see*: `20/20 runs passed. Contract mined for create_invoice`.

3. **Step 3: Trigger Bad Deploy**  
   *What it does*: Upgrades the agent to model `v2` and removes the camelCase prompt rule. Triggers silent failures (snake_case `invoice_id` returned with HTTP 200).  
   *What you see*: Real-time change stream flags an incident. Red violation cards appear on the Live feed.

4. **Step 4: Factorial Replay Grid**  
   *What it does*: Replays test corpus inputs across all $2^2 = 4$ combinations (model $\times$ prompt) in an ephemeral sandbox.  
   *What you see*: Evaluates 4 cells. Assigns 50% blame share to the model bump and 50% blame share to the prompt edit with 0% to decoy config.

5. **Step 5: Resolve Incident & Save Lesson**  
   *What it does*: Marks the incident resolved, recording root-cause symptoms, fix descriptions, and culprit axes into MongoDB episodic memory.  
   *What you see*: Lesson saved with source `incident`.

6. **Step 6: Preflight Check Proposed v3 (The Finale)**  
   *What it does*: Simulates a developer proposing model `v3` without the camelCase rule. Waypoint replays the change, queries past memory, and intercepts the deployment.  
   *What you see*: **`Verdict: BLOCK`**. Cites the lesson saved in Step 5 with: `Structural: same rule (unexpected_similar_key) on key "invoiceId" and axes [model, prompt]`.

> [!NOTE]
> **Embedding Rate Limits**: If a note saying *"semantic search temporarily unavailable"* appears, the system has gracefully fallen back to in-app lexical token search due to the Voyage AI 3 requests/minute free trial rate limit. Ranking and structural preflight guards continue to function normally.

---

## 2. What is Simulated (Full Transparency)

To ensure 100% reproducible evaluations for hackathon judges with zero external API dependencies or nondeterministic LLM flakiness:
- **Simulated Invoice Extractor**: The agent in `demo/invoice-agent/agent.ts` is a deterministic simulation driven by a seeded pseudo-random number generator (Mulberry32).
- **Planted Bug**: The bug (using snake_case `invoice_id` instead of `invoiceId`) triggers deterministically **only** when `model === 'v2'` (or `'v3'`) **and** the prompt lacks `"Always use camelCase keys"`.
- **Seeded Historical Lessons**: Sandboxes include two historical example lessons to illustrate memory search; your actual incident lesson saved in Step 5 takes precedence.

---

## 3. What Waypoint Does & Does Not Do (Scope)

See [`docs/01_PROBLEMS.md`](./docs/01_PROBLEMS.md) for the complete problem taxonomy.

### What Waypoint Does
- **Records Run Histories**: Content-hashed context snapshots and structured tool execution traces.
- **Mines Invariant Contracts**: Automatically infers required keys and value types from a chosen baseline version.
- **Detects Silent Regressions**: Real-time sliding-window failure rate monitoring via MongoDB Change Streams.
- **Fair Blame Attribution**: Cooperative game-theoretic Shapley credit assignment over factorial replay grids.
- **Episodic Regression Guard**: Hybrid semantic vector search + lexical matching to block repeat failures before deployment.

### What Waypoint Does NOT Do
- **No Autonomous Code Patching**: Waypoint does not automatically modify or patch application code; it is a detection, diagnostic, and review tool with a human in the loop.
- **No Automated Canary Rollbacks**: Waypoint is not an infrastructure orchestrator (no Kubernetes/traffic shifting built).
- **No Continuous Unsupervised Mining**: Contracts are mined from an explicit baseline version, not continuously from unvetted live traffic.
- **Not Arbitrary App Replay**: The replay engine is purpose-built and calibrated for structured agent tool calls.

---

## 4. System Architecture & Data Flow

```
  Simulated Agent / SDK ──(POST /v1/events)──► Fastify Server (Port 3000)
                                                    │ Validate & redact secrets
                                                    ▼
                                               MongoDB (Atlas M0)
                                      events · contexts · contracts · incidents
                                                    │
                             ┌─────────────── Change Streams ───────────────┐
                             ▼                                              ▼
                     Incident Detector                              Live SSE Fan-Out
                 (sliding-window thresholds)                                │
                             │                                              ▼
                             ▼                                       Web Dashboard
                      Replay Sandbox                                (React SPA at /)
                 (factorial grid evaluation)
                             │
                             ▼
                      Shapley Engine ──► Blame Shares (Model / Prompt / Config)
                             │
                             ▼
                      Episodic Memory ──► Preflight Regression Guard (BLOCK / PASS)
                   ($vectorSearch + RRF)
```

### Data Flow in 6 Lines
1. The agent executes tasks and streams tool calls through the Waypoint SDK to `POST /v1/events`.
2. Fastify validates payloads against Zod schemas, deeply redacts secrets, and inserts records idempotently into MongoDB.
3. MongoDB Change Streams feed real-time run telemetry to the detector, which tracks violation rates against mined contracts.
4. When failure rates cross threshold, an incident is created and a $2^k$ factorial replay grid is executed across test inputs.
5. The replay engine calculates Shapley values, apportioning blame shares across prompt, model, and configuration changes.
6. Resolved incidents become episodic lessons; preflight checks replay candidate updates and block repeat regressions.

---

## 5. MongoDB Features Used

| Feature | Where Used | Purpose |
|---|---|---|
| **Flexible Schema Documents** | `events`, `contexts`, `contracts` | Stores polymorphic LLM tool arguments, multi-turn contexts, and dynamic JSON schema invariants without schema migrations. |
| **Change Streams (`$watch`)** | `server/src/detect/detector.ts`, `server/src/stream/routes.ts` | Real-time reactive incident detection on `runs` and shared singleton SSE streaming to active dashboard sessions. |
| **Aggregation Pipelines** | `server/src/contracts/mine.ts` | Mines structural invariants (`$match`, `$project`, `$objectToArray`, `$unwind`, `$group`) to extract required keys and types from baseline runs. |
| **Vector Search (`$vectorSearch`)** | `server/src/lessons/recall.ts` | 1024-dimension cosine similarity search over episodic memory lessons using Voyage-4 embeddings. |
| **In-App Lexical Matching + RRF** | `server/src/lessons/recall.ts` | Exact identifier and token overlap matcher combined with vector search via Reciprocal Rank Fusion ($k=60$). |
| **Partial Unique Indexes** | `server/src/db/init.ts` | `{ projectId: 1, badHash: 1 }` with partial filter `{ status: 'open' }` guarantees exactly one open incident per regression. |
| **Compound B-Tree Indexes** | `events` (`{ projectId: 1, runId: 1, seq: 1 }`) | Enables zero-in-memory-sort index scans (`IXSCAN`) for chronological run reconstruction. |
| **TTL Indexes** | `meta_sandboxes` (`{ expiresAt: 1 }`, expireAfterSeconds: 0) | Automatically expires and garbage-collects transient guest sandbox data after 30 minutes. |

---

## 6. Measured Benchmark & Gate Results

All metrics are sourced directly from [`docs/MEASURED_FACTS.md`](./docs/MEASURED_FACTS.md):

| Category | Test Description | Measured Result |
|---|---|---|
| **Ingestion Concurrency** | 1,000 simultaneous duplicate HTTP events (`gate:3`) | **Exactly 1 document stored**, 999 `duplicate_ignored` |
| **Context Concurrency** | 200 concurrent context registrations (`gate:5`) | **Exactly 1 document stored**, 1 created, 199 deduplicated |
| **Attribution Accuracy** | Factorial replay grid on model $\times$ prompt (`gate:9`) | Model blame: **50.0%**, Prompt blame: **50.0%**, Decoy config: **0.0%** |
| **Shapley Efficiency** | $\lvert \sum \phi_i - [v(N) - v(\emptyset)] \rvert$ (`gate:9`) | **$1.11 \times 10^{-16}$** (strict mathematical efficiency) |
| **Semantic Recall** | Held-out evaluation set ($n = 12$ split, `gate:10b`) | Rank-only Hit@3: **100%** (7/7); Strong-tier Hit@3: **57.1%** (4/7) |
| **False Warnings** | Negative control queries on held-out split (`gate:10b`) | **0.0% false warnings** (0/5 false positives on non-incident queries) |
| **Preflight Interception** | Replay of proposed bad update v3 (`gate:11h`) | **60 of 60 replay runs violate contract** $\to$ **`Verdict: BLOCK`** |
| **System Hygiene** | Playwright browser smoke test (`browser-smoke.ts`) | **0 secrets leaked** across all network requests; steps 1–6 verified |
| **Full Gate Suite** | Complete gate verification suite (`gate:all`) | **15 of 15 gates PASS** (100% pass rate, 0 skipped) |

> [!NOTE]
> **Attribution & Eval Caveats**:
> 1. Shapley values quantify credit assignment across replay experiments; they represent experimental blame sharing rather than causal proof.
> 2. The recall evaluation set is small ($n = 24$ total, $n = 12$ held-out). Strong-tier recall reflects a conservative threshold ($0.48$) calibrated to eliminate false warnings.

---

## 7. Local Development Setup

### Prerequisites
- Node.js 22+
- pnpm 9+
- Docker Desktop (for MongoDB with vector search)

### Environment Configuration
Copy `.env.example` to `.env` (no values are pre-committed):

| Variable | Description |
|---|---|
| `NODE_ENV` | `development` or `production` |
| `PORT` | Local port (default `3000`) |
| `MONGODB_URI` | MongoDB connection string (`mongodb://127.0.0.1:27017/?directConnection=true`) |
| `MONGODB_DB` | Database name (`waypoint_local`) |
| `API_KEYS` | Comma-separated API keys for write operations |
| `EMBED_PROVIDER` | `atlas_voyage`, `ollama`, or `none` |
| `EMBED_API_KEY` | MongoDB Atlas Voyage Model API key |
| `EMBED_BASE_URL` | `https://ai.mongodb.com/v1` |
| `EMBED_MODEL` | `voyage-4` |
| `EMBED_DIM` | `1024` |
| `EMBED_MAX_RPM` | Rate limit cap (`3` on free trial) |

### Commands (Verified in Clean Shell)
```bash
# 1. Install dependencies
pnpm install

# 2. Start local MongoDB container (replica set enabled)
docker compose up -d

# 3. Start Fastify backend & static web server (Port 3000)
pnpm dev:server

# 4. Run external agent runner to generate live traffic
pnpm agent:run --scenario good --count 20

# 5. Run mid-run breaking deployment simulation
pnpm agent:run --scenario good --ship-change bad_deploy --count 30

# 6. Execute full 15-gate verification suite
pnpm gate:all
```

---

## 8. Production Deployment (Render / Cloud)

Waypoint packages the Fastify backend and React frontend into a unified, single-container Docker image (`server/Dockerfile`).

### Render Configuration
- **Service Type**: Web Service (Docker runtime)
- **Repository**: Connected to GitHub repository
- **Root Directory**: Leave blank (repo root)
- **Dockerfile Path**: `./server/Dockerfile`
- **Docker Build Context**: `.` (repo root)
- **Health Check Path**: `/health`
- **Instance Count**: Exactly `1` (sandbox locks and rate limits are managed in-memory)
- **Auto-Deploy**: Disabled for judging freeze

### Required Production Environment Variables
- `NODE_ENV=production`
- `MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority`
- `MONGODB_DB=waypoint_prod`
- `API_KEYS=<generated-random-secret>`
- `EMBED_PROVIDER=atlas_voyage`
- `EMBED_API_KEY=<atlas-voyage-model-api-key>`
- `EMBED_BASE_URL=https://ai.mongodb.com/v1`
- `EMBED_MODEL=voyage-4`
- `EMBED_DIM=1024`
- `EMBED_MAX_RPM=3`
- `LLM_ENABLED=false`
- `READ_PUBLIC_PREFIX=demo-`

---

## 9. Known Limitations & Engineering Gaps

1. **Atlas Voyage RPM Quota**: The free MongoDB Atlas Voyage API allows 3 requests per minute. Rapid custom queries trigger automatic fallback to in-app lexical matching.
2. **Single-Instance In-Memory Locks**: Sandbox concurrency locks and rate-limiting buckets operate in-memory on the Fastify instance; horizontal scaling across multiple instances would require distributed Redis or MongoDB document leases.
3. **Mined Contract Scope**: Invariant mining currently covers presence of required keys and primary BSON types; custom semantic validation rules (e.g., regex constraints or cross-field comparisons) require manual specification.
4. **Evaluation Corpus Size**: The retrieval evaluation set consists of 24 queries (12 calibration, 12 held-out); enterprise deployments would benefit from broader domain-specific validation sets.

---

## 10. Credits & Prior Art

- **Factorial Replay & Delta Debugging**: Inspired by Andreas Zeller's work on Delta Debugging and factorial experimental design in software testing.
- **Cooperative Game Theory**: Shapley value credit assignment based on Lloyd Shapley's axiomatic solution for fair distribution of collective outcomes.
- **Third-Party Libraries**: Fastify (MIT), MongoDB Node Driver (Apache-2.0), Zod (MIT), React (MIT), Recharts (MIT), Lucide (ISC), and Diff (BSD-3-Clause). See [`THIRD_PARTY.md`](./THIRD_PARTY.md) for full license details.

---

## 11. AI Assistance Disclosure

AI coding assistants (Google DeepMind Antigravity) were utilized during the development of Waypoint to assist with boilerplate generation, test script scaffolding, and documentation formatting. All architectural designs, algorithmic implementations, mathematical proofs, and test verifications were reviewed, debugged, and validated by the team.
