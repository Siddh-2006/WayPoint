# Features: One Chain, Each Step Feeding the Next

Status labels: **Built** means it exists and its gate passed. **Planned** means designed but not finished. Update this file as work lands.

---

## The chain at a glance

```
1 Safe ingest -> 2 Versioned contexts -> 3 Learned rules -> 4 Live detection
      -> 5 Replay and blame -> 6 Lessons -> 7 Preflight check -> 8 Dashboard
      -> 9 Narration -> 10 Agent access (MCP) -> 11 Extras
```

---

## 1. Safe ingest (Built)
- Accepts single or batched events with strict validation
- Stable event IDs make duplicates harmless
- Secrets are masked before storage
- Out-of-order events are sorted on read
- **Feeds into:** versioned contexts, because every run needs trustworthy history to attach to.

## 2. Versioned contexts and automatic diff (Built)
- Model, prompt, settings, tool definitions and dependencies are fingerprinted with SHA-256
- A new fingerprint means a new version, found automatically
- Typed diff shows exactly what differs, with a line diff for prompts
- **Feeds into:** learned rules, because rules are mined from the runs of one specific version.

## 3. Learned contracts (Built)
- Rules are mined from good runs using a MongoDB aggregation
- A key is required only if it appears in at least 98 percent of baseline runs
- With too few baseline runs, the system says "no baseline yet" and flags nothing
- **Feeds into:** live detection, which checks every new run against these rules.

## 4. Live violation detection and incidents (Built)
- Every finished run is checked and its violations stored
- A change stream feeds a sliding-window failure rate per version
- One incident per bad version, with evidence run IDs and the list of changes
- Resume tokens mean a restart loses nothing
- **Feeds into:** replay, which investigates the incident's list of changes.

## 5. Replay experiments and fair blame (Built)
- All combinations of the changed units are replayed on the same inputs
- The same contract checker decides pass or fail
- Wilson intervals give honest verdicts: failing, ok or inconclusive
- Shapley values share blame fairly, including interaction between changes
- Exact for up to four units, sampled beyond that (and labeled so)
- Results are cached so repeats cost nothing, and replay never touches live data
- **Feeds into:** lessons, because the blame result becomes part of the saved lesson.

## 6. Episodic memory: lessons (Built)
- Resolving an incident saves symptom, culprit, change types, fix, and **violated rule refs** (`violatedRules`: rule type + expected key per violation)
- Lessons can be corrected or expire automatically
- Embeddings generated via MongoDB Atlas Embedding and Reranking API (`voyage-4`, 1024-dim, authenticated via Atlas Model API Key)
- Recall combines semantic vectors and exact keyword tokens via Reciprocal Rank Fusion (RRF k=60), scoped by project
- **Violation-based recall query**: when preflight replay produces violations, the recall query is built from the violation messages (same vocabulary as `lesson.symptom`) rather than the raw change diff — this ensures like-for-like semantic comparison and dramatically improves cosine match quality
- **Deterministic structural match** (no cosine threshold required): a lesson is a strong match if all of:
  1. `lesson.violatedRules` contains an entry `(rule, expectedKey)` that also appears in the new replay violations
  2. The proposal's changed axes overlap `lesson.culprit.units`
  When both fire, the lesson is cited with reason `"same rule and axes"` regardless of cosine score — this is exact comparison, not a tuned threshold, and easy to defend in Q&A
- Both signals are shown in preflight reasons: cosine (if any) and structural reason
- Honest threshold calibration on held-out eval set ($n=24$ queries, 12 calibration / 12 held-out):
  - Calibrated threshold `LESSON_MIN_SCORE = 0.48` on calibration split
  - Raw cosine score normalization across Atlas Vector Search and in-memory fallback
  - UI tiering: "strong match" (cosine ≥ 0.48 OR structural match) vs "weak match" (verdict remains pass)
  - Held-out test performance ($n=12$): Strong-tier Hit@1 = 57% (4/7), Strong-tier Hit@3 = 57% (4/7), Negative False-Warning Rate = 0% (0/5). Rank-only Hit@3 without cutoff is 100% (7/7).
- Rate limit resilience: `EMBED_MAX_RPM = 3` client pacing, `QueryEmbeddingLruCache`, demo precomputation at startup, and graceful fallback to `text_only` with note `"semantic search temporarily unavailable"` on HTTP 429
- Structural match works correctly with `EMBED_PROVIDER=none` and when embed throws 429 (text_only recall path)
- "No prior incident" is a valid, honest answer
- Seeded example lessons are labeled so they are never mistaken for real history
- **Feeds into:** preflight, which uses lessons to warn.

## 7. Preflight check (Built)
- Diffs a proposed version against the live one
- Replays the inputs and recalls similar lessons using **two complementary signals**:
  1. **Semantic signal**: when replay produces violations, the recall query is built from violation messages (same vocabulary as lesson symptoms), improving cosine match quality from ~0.45 to ~0.88 on exact reoccurrences
  2. **Structural signal**: deterministic — if the new replay violates the same rule on the same key and the proposal touches the same axes as the lesson's culprit, the lesson is cited as a strong match with reason `"same rule and axes"` (no threshold, easy to audit)
- Gives **block**, **warn** or **pass** with reasons
- Both signals and cosine scores are shown in reasons; judges can inspect exactly why a lesson was cited
- Refuses to guess when there is no baseline
- **Feeds into:** the dashboard, where a developer sees the verdict before shipping.

## 8. Live dashboard (Built)
- Live run stream, incident view, contracts view, experiments grid with Shapley chart
- Lessons page and preflight page
- Scenario buttons run the simulated agent server-side, so the browser never holds a key
- A visible label marks the agent as simulated
- **Feeds into:** narration, which makes the same facts easy to read.

## 9. Evidence-cited narration (Built)
- A language model writes a short readable explanation from a compact computed summary
- Driven by real local model (`qwen2.5:3b` via Ollama) or hosted OpenAI-compatible endpoints
- Each sentence must cite the evidence it relies on (`[F1]`, `[F2]`, etc.)
- Strict citation validator drops unverified facts and ungrounded numbers; prompt-injection defenses discard hostile commands
- Deterministic grounded template fallback on timeout or validation failure
- **Feeds into:** agent access, where the same summary is returned to coding agents.

## 10. Agent access through MCP (Built)
- Exposes `preflight_change`, `explain_incident`, `recall_lessons`, `list_incidents`, and `get_deployment_status` as tools via stdio
- Strictly read-only: verified 0 document writes across all collections
- No API key leakage in tool outputs or error messages
- Allows coding assistants in Claude Desktop, Cursor, and Antigravity to run preflight verification via MCP or API before shipping
- **Feeds into:** extras, where agents can trigger the same safety checks automatically.

## 11. Extras & Diagnostics (Built & Planned)
- **Built:** `explain()` panel showing index use (`IXSCAN`) and non-zero returned documents across all 4 production queries (`runs_by_project_and_context`, `events_by_run`, `contracts_by_project`, `lessons_by_project_and_status`), plus an unindexed control query confirming `COLLSCAN` detection
- Planned: Change-point detection to timestamp when a regression began
- Planned: Output-drift detection with embeddings
- Planned: Sequential canary test and automatic rollback
- Planned: Structural trace comparison showing the first step where two runs diverge

---

## Quality features that cut across everything (Built)
- Every feature has a gate script that must pass with real output
- Idempotent writes and graceful restart
- All configuration from environment variables
- Statistical honesty: no baseline, inconclusive and sampled results are shown, never hidden

## Known limits
- Only changes reported through the SDK are visible
- The demo agent is simulated; its bug (snake_case `invoice_id` key) is deliberately planted and triggers on models `v2` and `v3` when the camelCase prompt guard is absent — this is documented in code and README
- Replay currently works on the demo agent only
- Shapley values describe credit across replay results, not proven causation
- Threshold `LESSON_MIN_SCORE = 0.48` was calibrated on $n=12$ queries (small evaluation); structural match provides a threshold-free second signal
