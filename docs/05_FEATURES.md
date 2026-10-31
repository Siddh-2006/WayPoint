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
- Resolving an incident saves symptom, culprit, change types and fix
- Lessons can be corrected or expire automatically
- Recall combines meaning (vectors) and exact words (text), scoped by project
- "No prior incident" is a valid, honest answer
- Seeded example lessons are labeled so they are never mistaken for real history
- **Feeds into:** preflight, which uses lessons to warn.

## 7. Preflight check (Built)
- Diffs a proposed version against the live one
- Replays the inputs and recalls similar lessons
- Gives **block**, **warn** or **pass** with reasons
- Refuses to guess when there is no baseline
- **Feeds into:** the dashboard, where a developer sees the verdict before shipping.

## 8. Live dashboard (Built)
- Live run stream, incident view, contracts view, experiments grid with Shapley chart
- Lessons page and preflight page
- Scenario buttons run the simulated agent server-side, so the browser never holds a key
- A visible label marks the agent as simulated
- **Feeds into:** narration, which makes the same facts easy to read.

## 9. Evidence-cited narration (Planned)
- A language model writes a short readable explanation from a compact computed summary
- Each sentence must cite the evidence it relies on
- Works with a local model or a hosted one through configuration
- **Feeds into:** agent access, where the same summary is returned to coding agents.

## 10. Agent access through MCP (Planned)
- Exposes preflight, explain and recall as tools that coding agents can call before deploying
- **Feeds into:** extras, where agents can trigger the same safety checks automatically.

## 11. Extras if time allows (Planned)
- `explain()` panel showing index use for each diagnosis query
- Change-point detection to timestamp when a regression began
- Output-drift detection with embeddings
- Sequential canary test and automatic rollback
- Structural trace comparison showing the first step where two runs diverge

---

## Quality features that cut across everything (Built)
- Every feature has a gate script that must pass with real output
- Idempotent writes and graceful restart
- All configuration from environment variables
- Statistical honesty: no baseline, inconclusive and sampled results are shown, never hidden

## Known limits
- Only changes reported through the SDK are visible
- The demo agent is simulated
- Replay currently works on the demo agent only
- Shapley values describe credit across replay results, not proven causation
