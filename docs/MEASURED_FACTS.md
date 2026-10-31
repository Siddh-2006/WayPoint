# Waypoint — Measured Facts & Single Source of Truth

> [!IMPORTANT]
> This document is the strict, single source of truth for all quantitative claims, benchmark results, and evaluation metrics in Waypoint.
> Every number in `README.md`, `docs/DEMO_SCRIPT.md`, `docs/PPT_OUTLINE.md`, and `docs/QA_PREP.md` is derived solely from the empirical data below.
> Nothing is invented, rounded up, or extrapolated.

Last updated: **2026-10-31**  
Test environment: Node v23.0.0, TypeScript 5.6.0, Fastify 5.2.0, MongoDB Atlas Local 8.0.16 (Docker) / MongoDB Atlas M0 replica set.

---

## 1. Concurrency, Ingestion & Deduplication

| Metric | Measured Value | Sample Size ($n$) | Gate / Script | Date | Notes |
|---|---|---|---|---|---|
| Concurrent duplicate events deduplication | Exactly 1 document stored, 999 `duplicate_ignored` | $n = 1,000$ concurrent HTTP POSTs | `scripts/src/gate3.ts` | 2026-10-31 | Code 11000 caught; returns HTTP 201 with `{ status: "duplicate_ignored" }`. |
| Concurrent context registration deduplication | Exactly 1 document stored, 1 `created: true`, 199 `created: false` | $n = 200$ concurrent HTTP POSTs | `scripts/src/gate5.ts` | 2026-10-31 | Content-hashed SHA-256 context deduplication across parallel workers. |
| Hard case duplicate events deduplication | Exactly 1 document stored, 49 `duplicate_ignored` | $n = 50$ concurrent HTTP POSTs | `scripts/src/gate12.ts` | 2026-10-31 | Validates idempotency under rapid bursts. |
| Concurrent sandbox reset isolation | Exactly one HTTP 200, exactly one HTTP 409 | $n = 2$ simultaneous reset requests | `scripts/src/gate12.ts` | 2026-10-31 | Atomic reset lock prevents split-brain state during sandbox resets. |
| Ingestion rate limit enforcement | HTTP 429 Too Many Requests | Threshold: 100 req/min | `scripts/src/gate12.ts` | 2026-10-31 | In-memory token bucket per client IP. |
| SSE client connection cap | 50 accepted, 51st rejected with HTTP 429 | $n = 51$ concurrent SSE streams | `scripts/src/gate12.ts` | 2026-10-31 | Prevents cursor and socket exhaustion on shared change stream fan-out. |
| Sandbox capacity limit | HTTP 429 after 50 active sandboxes | Threshold: 50 active demo sandboxes | `scripts/src/gate12.ts` | 2026-10-31 | Evicts expired sandboxes (TTL > 30 min) and bounds storage. |
| Public sandbox authorization | HTTP 403 Forbidden on non-`demo-` projects | Arbitrary project ID strings | `scripts/src/gate12.ts` | 2026-10-31 | Enforces prefix isolation on unauthenticated `/v1/demo/*` endpoints. |

---

## 2. Factorial Replay Grid & Shapley Blame Attribution

| Metric | Measured Value | Sample Size ($n$) | Gate / Script | Date | Notes |
|---|---|---|---|---|---|
| Replay grid evaluation size | 4 cells evaluated ($2^2$ factorial: model $\times$ prompt) | 20 corpus inputs $\times$ 4 cells = 80 evaluations | `scripts/src/gate9.ts` | 2026-10-31 | Factorial grid covers all subset combinations of proposed changes. |
| Cell 00 (v1 model + camelCase prompt) violation rate | 0% (0 / 20 runs violated) | $n = 20$ inputs | `scripts/src/gate9.ts` | 2026-10-31 | Clean baseline state. |
| Cell 11 (v2 model + missing camelCase prompt) violation rate | 100% (20 / 20 runs violated) | $n = 20$ inputs | `scripts/src/gate9.ts` | 2026-10-31 | Bad deploy state (reproduces production incident). |
| Cell 10 (v2 model + camelCase prompt) violation rate | 0% (0 / 20 runs violated) | $n = 20$ inputs | `scripts/src/gate9.ts` | 2026-10-31 | Model upgrade alone does not trigger failure when guard prompt is kept. |
| Cell 01 (v1 model + missing camelCase prompt) violation rate | 0% (0 / 20 runs violated) | $n = 20$ inputs | `scripts/src/gate9.ts` | 2026-10-31 | Old model adheres to schema even without explicit camelCase prompt. |
| Shapley attribution: Model blame share | 50.0% ($\phi_{\text{model}} = 0.500$) | $n = 80$ evaluations | `scripts/src/gate9.ts` | 2026-10-31 | Blame share calculated across all marginal contributions. |
| Shapley attribution: Prompt blame share | 50.0% ($\phi_{\text{prompt}} = 0.500$) | $n = 80$ evaluations | `scripts/src/gate9.ts` | 2026-10-31 | Interacting failure: both factors share blame equally. |
| Shapley attribution: Decoy config blame share | 0.0% ($\phi_{\text{config}} = 0.000$) | $n = 80$ evaluations | `scripts/src/gate9.ts` | 2026-10-31 | Correctly exonerates chunk size decoy parameter. |
| Shapley Efficiency Axiom error ($\lvert \sum \phi_i - [v(N) - v(\emptyset)] \rvert$) | $1.11 \times 10^{-16}$ (machine epsilon) | $n = 80$ evaluations | `scripts/src/gate9.ts` | 2026-10-31 | Mathematical proof that blame shares sum exactly to total net risk increase. |
| Replay execution isolation | 0 documents written to `runs` or `events` collections | 80 replay iterations | `scripts/src/gate9.ts` | 2026-10-31 | Replays run in an ephemeral sandbox and never poison live telemetry. |

> [!NOTE]
> **Attribution Caveat**: Shapley values represent cooperative credit assignment (blame shares) over replay experiments. They quantify how much each change contributed to the violation rate observed across the replay grid; they do not constitute mathematical proof of physical causality.

---

## 3. Episodic Memory Recall & Calibration (Voyage-4)

- **Dataset**: `demo/lessons-eval.json` ($n = 24$ total queries: 14 positives, 10 negatives).
- **Split**: 50/50 disjoint train/test split (12 calibration queries: 7 positives, 5 negatives; 12 held-out evaluation queries: 7 positives, 5 negatives).
- **Embedding Model**: MongoDB Atlas Embedding API (`voyage-4`, 1024 dimensions).
- **Calibrated Threshold**: `LESSON_MIN_SCORE = 0.48` (calibrated on the 12-query calibration set to minimize false positives while preserving true hits).

### Held-Out Test Set Results ($n = 12$)

| Mode | Rank-Only Hit@3 | Strong-Tier Hit@3 ($\text{score} \ge 0.48$) | False-Warning Rate ($\text{score} \ge 0.48$ on Negatives) |
|---|---|---|---|
| **Vector Search (`voyage-4`)** | **100%** (7 / 7) | **57.1%** (4 / 7) | **0.0%** (0 / 5) |
| **Reciprocal Rank Fusion (RRF, $k=60$)** | **100%** (7 / 7) | **57.1%** (4 / 7) | **0.0%** (0 / 5) |
| **Lexical Token-Overlap (Text-Only)** | 42.9% (3 / 7) | 28.6% (2 / 7) | **0.0%** (0 / 5) |

### Hard Paraphrase Ranking ($n = 5$ True Paraphrases)
- Queries with zero keyword overlap (e.g., *"Invoice object lacks camelCase identifier; found snake_case"*):
  - **Vector Search (`voyage-4`)**: Ranked the correct lesson at **#1** on all 5 paraphrases.
  - **Lexical Text Search**: Failed to match (`UNMATCHED` / Rank 0).
  - Scores on paraphrases range from raw cosine $0.41$ to $0.70$. Queries above $0.48$ trigger strong warnings; queries between $0.40$ and $0.48$ are safely classified as "weak match" without crying wolf.

> [!NOTE]
> **Evaluation Size Caveat**: The evaluation set is small ($n = 24$ total, $n = 12$ held-out). It proves semantic ranking significantly outperforms keyword search on paraphrases, but absolute generalization should not be extrapolated to enterprise corpora without retraining or larger validation sets.

---

## 4. Preflight Guard & Finale Verification

| Check | Measured Outcome | Script / Test | Date |
|---|---|---|---|
| Proposed v3 (Model v3 without camelCase prompt) replay violations | 60 of 60 replay evaluations violated contract | `scripts/src/gate11h.ts`, `scripts/src/gate12.ts` | 2026-10-31 |
| Preflight verdict on Proposed v3 | `Verdict: BLOCK` | `scripts/src/gate11h.ts`, `scripts/src/browser-smoke.ts` | 2026-10-31 |
| Preflight lesson citation | Matched past incident lesson (source: `incident`); Structural match: same rule (`unexpected_similar_key`) on key `invoiceId` and axes [`model`, `prompt`] | `scripts/src/gate11h.ts`, `scripts/src/browser-smoke.ts` | 2026-10-31 |
| Proposed harmless change (chunkSize 512 $\to$ 256) | 0 of 20 replay runs violated contract; `Verdict: PASS` | `scripts/src/gate11h.ts` | 2026-10-31 |
| Unrelated violation negative control | Did not match past lesson; cited 0 past lessons | `scripts/src/gate11h.ts` | 2026-10-31 |

---

## 5. Playwright Browser Smoke Test (Full Click-Through)

- **Script**: `scripts/src/browser-smoke.ts`
- **Execution Date**: 2026-10-31
- **Target URL**: `http://localhost:3000/guide`
- **Steps Verified**:
  1. Step 1 (Reset Sandbox) $\to$ Cleanly reset and seeded 12 baseline runs.
  2. Step 2 (Run Baseline) $\to$ 20/20 runs passed; contract mined for `create_invoice`.
  3. Step 3 (Bad Deploy) $\to$ Silent failures triggered; incident opened.
  4. Step 4 (Run Replay Grid) $\to$ 4-cell factorial replay grid completed; Shapley blame assigned.
  5. Step 5 (Resolve Incident) $\to$ Incident resolved; lesson saved to episodic memory.
  6. Step 6 (Preflight Proposed v3) $\to$ `Verdict: BLOCK` with structural citation of Step 5 lesson.
- **Security Audit**: **0 secrets** (API keys, MongoDB credentials, tokens) detected across all request and response bodies during the entire session.

---

## 6. Full Gate Suite Execution (`pnpm gate:all`)

- **Execution Date**: 2026-10-31
- **Flags**: Ran in full **WITHOUT** `--skip-network`.
- **Results**: 15 out of 15 gates passed (100% pass rate, 0 skipped).

```text
========================================================================
 GATE SUITE SUMMARY TABLE
========================================================================
| Gate       | Status    | Duration | Notes                                  |
|------------|-----------|----------|----------------------------------------|
| gate:2     | PASS      | 1.9s     | DB initialization idempotent           |
| gate:3     | PASS      | 3.7s     | 1,000 concurrent duplicate ingest      |
| gate:5     | PASS      | 2.0s     | 200 concurrent context registrations   |
| gate:6     | PASS      | 1.6s     | Simulated agent, corpus & SDK          |
| gate:7     | PASS      | 4.0s     | Invariant mining & incident detector   |
| gate:8     | PASS      | 17.4s    | React dashboard & live SSE change stream|
| gate:9     | PASS      | 7.3s     | Factorial replay grid & Shapley blame  |
| gate:10    | PASS      | 181.7s   | Live Voyage-4 API & embedding recall   |
| gate:10b   | PASS      | 139.0s   | Live Voyage-4 held-out eval set (n=12) |
| gate:11d   | PASS      | 136.9s   | Live Ollama qwen2.5:3b with [F1]..[F4] |
| gate:11e   | PASS      | 27.5s    | Honest threshold calibration (split n=24)|
| gate:11f   | PASS      | 74.9s    | Product-aligned strong-tier recall     |
| gate:11g   | PASS      | 47.8s    | Realistic preflight & weak match format|
| gate:11h   | PASS      | 91.9s    | Preflight block & structural citation  |
| gate:12    | PASS      | 48.7s    | Sandbox isolation, caps & hygiene      |
========================================================================
Total duration: ~13 minutes (paced by Voyage AI 3 RPM trial limit)
```

---

## 7. MongoDB Features & Index Explain Results

| MongoDB Feature | Exact Collection & Index | Measured Operation / Query | Explain Result / Verification |
|---|---|---|---|
| Compound Index & Sorting | `events` (`{ projectId: 1, runId: 1, seq: 1 }`) | `GET /v1/runs/:runId/events` | `IXSCAN` on `events_project_run_seq`, 0 in-memory sort (`scripts/src/gate11d.ts`). |
| Unique Partial Index | `incidents` (`{ projectId: 1, badHash: 1 }` where `status: "open"`) | Consecutive bad deploy runs | Code 11000 caught; exactly 1 open incident per regression (`scripts/src/gate7.ts`). |
| TTL Index | `meta_sandboxes` (`{ expiresAt: 1 }`, expireAfterSeconds: 0) | Eviction of inactive sandboxes | Expired sandbox data deleted automatically by MongoDB background thread (`scripts/src/gate12.ts`). |
| Change Streams | `runs` and `incidents` | Singleton shared change stream cursor with in-memory fan-out | Tested under concurrent SSE client load (`scripts/src/gate8.ts`). |
| Vector Search | `lessons` (`lessons_vector`) | 1024-dimension cosine similarity | Live `$vectorSearch` via Atlas Embedding API (`voyage-4`). |
| In-App Lexical + RRF | `lessons` | Token-overlap and exact-identifier search combined with RRF ($k=60$) | Reciprocal Rank Fusion ranks relevant past incidents without Lucene dependency (`server/src/lessons/recall.ts`). |

---

## 8. What is NOT Measured / NOT Built (Explicit Out-of-Scope)

To preserve strict engineering honesty with hackathon judges:

1. **Benchmark C (10,000 runs burst)**: Not run; skipped to avoid burning API quotas. Concurrency verified at $n=1,000$.
2. **Autonomous Canary / Automatic Rollbacks**: NOT built. Waypoint is a detection, blame attribution, and preflight review tool. Incidents are resolved with a human in the loop.
3. **Continuous Mining**: Contracts are NOT mined continuously on live unverified streams. They are mined from a designated baseline version.
4. **Structural AST Trace Diffing**: NOT built. Diffing operates on JSON context structures (model, prompt text, configuration, tool schemas).
5. **Change-Point Detection**: Incidents trigger on a sliding-window violation rate threshold, not statistical cumulative sum (CUSUM) change-point models.
6. **Downstream Microservice Dependency Graph**: NOT built.
7. **Arbitrary Production Agent Replay**: The replay engine is purpose-built and calibrated for the simulated invoice agent and structured tool calls.

