# Waypoint — Video Demo Script (Target: 6:30, Hard Limit: 7:00)

> [!IMPORTANT]
> This script maps directly to the hackathon rubric's 4 core beats:
> 1. Run the tool live
> 2. Show historical telemetry in MongoDB
> 3. Demonstrate real-time change stream updates
> 4. Walk through a realistic silent failure recovery

---

## Pre-Recording Checklist

- [ ] **Clean Browser State**: Close all unrelated tabs; open an incognito window at the deployed URL (e.g. `https://waypoint-production-c529.up.railway.app/guide`).
- [ ] **Display Zoom**: Set browser zoom to 110% or 125% for high-DPI legibility.
- [ ] **Credential Safety**: Close `.env` and `.env.atlas` files in your IDE. Ensure terminal history does not print secrets.
- [ ] **Reset State**: Click **Reset Sandbox** on `/guide` immediately before recording to ensure a fresh session.
- [ ] **Honest Badging**: Point out the `SIMULATED AGENT` and `TEMPLATE / LLM` status badges when on screen.
- [ ] **Voyage Fallback Plan**: If Voyage rate-limits (HTTP 429), the UI will show `semantic search temporarily unavailable`. Point out that the system gracefully falls back to lexical matching without crashing.

---

## Timestamped Narration & Action Flow

```
Total Target Runtime: 06:30
```

### 0:00 – 0:40 | Beat 1: The Problem & The Simulated Agent
- **Visual**: Title slide, then transition to browser showing an invoice processing agent.
- **Action**: Highlight the header badge: `SIMULATED AGENT`.
- **Narration**:
  > *"When teams deploy LLM agents to production, traditional unit tests and HTTP status codes fail them. An agent can return HTTP 200 while silently corrupting tool parameters or dropping required fields.*
  >
  > *To show this concretely and reproducibly without relying on nondeterministic external APIs, we built a simulated invoice extraction agent. When developers update the system prompt or bump the model, subtle regressions slip through: for example, outputting snake_case `invoice_id` instead of camelCase `invoiceId`. This breaks downstream systems without throwing an exception.*
  >
  > *Waypoint is a flight recorder and regression guard that captures runs, mines contracts, attributes blame across interacting changes, and prevents repeat mistakes using episodic memory."*

---

### 0:40 – 1:10 | Architecture & Data Flow
- **Visual**: Slide / diagram showing Waypoint architecture.
- **Action**: Trace the flow: Agent $\to$ Fastify $\to$ MongoDB $\to$ Change Stream Detector $\to$ Replay Grid $\to$ Episodic Memory $\to$ Preflight.
- **Narration**:
  > *"Here is how Waypoint works. Telemetry streams from an external agent or SDK into Fastify, which redacts secrets and inserts records into MongoDB.*
  >
  > *MongoDB Change Streams feed a real-time detector that tracks violation rates against mined contracts. When an incident occurs, a factorial replay sandbox isolates the culprit using Shapley attribution.*
  >
  > *Finally, past fixes are stored in MongoDB episodic memory, powering preflight checks that intercept bad deployments before they hit production."*

---

### 1:10 – 2:00 | External Agent Runner & Ingestion
- **Visual**: Split screen: Terminal running `pnpm agent:run` on left; Browser on `/` (Live Feed) on right.
- **Action**: Run `pnpm agent:run --scenario good --count 20`. Watch green event cards stream in via SSE.
- **Narration**:
  > *"Let's see live telemetry in action. In this terminal, an external agent processes invoices using the official Waypoint TypeScript SDK.*
  >
  > *Notice the events streaming into the dashboard via a shared MongoDB change stream. Every event is validated, content-hashed, and deduplicated. Even if the network retries 1,000 duplicate requests simultaneously, MongoDB idempotency guarantees exactly one document is stored."*

---

### 2:00 – 2:30 | Invariant Contract Mining (Step 2)
- **Visual**: Browser at `/guide` (Step 2: Run Baseline), then click to `/contracts`.
- **Action**: Click "Run Baseline" on `/guide`. Navigate to `/contracts` to show the mined schema.
- **Narration**:
  > *"On Step 2, Waypoint executes 20 baseline runs on model v1 with an explicit camelCase formatting rule.*
  >
  > *Using MongoDB aggregation pipelines, Waypoint analyzes successful runs and mines a structural contract for `create_invoice`: requiring `invoiceId` as a string and `amount` as a number. Contracts are mined deterministically from a chosen baseline version, never guessed by an LLM."*

---

### 2:30 – 3:15 | Beat 2: The Bad Deploy & Change Stream Incident (Step 3)
- **Visual**: Browser at `/guide` (Step 3: Bad Deploy), then switch to `/incidents`.
- **Action**: Click "Bad Deploy". Watch the status change and red violation cards appear. Open the active incident.
- **Narration**:
  > *"Now on Step 3, a developer ships two changes at once: upgrading to model v2 and removing the camelCase formatting prompt to save tokens.*
  >
  > *Immediately, silent failures occur. The agent still returns HTTP 200, but outputs `invoice_id`. MongoDB Change Streams detect that the failure rate exceeded our sliding-window threshold and automatically open an incident.*
  >
  > *Notice that partial unique indexes in MongoDB guarantee exactly one open incident exists per regression, preventing duplicate incident storms."*

---

### 3:15 – 4:00 | Beat 3: Factorial Replay Grid & Shapley Blame (Step 4)
- **Visual**: Browser on `/experiments` or `/guide` (Step 4: Run Replay Grid).
- **Action**: Click "Run Replay Grid". Expand the $2^2$ matrix and the Shapley attribution breakdown.
- **Narration**:
  > *"Because two variables changed simultaneously—the model and the prompt—developers usually argue about which one broke. Waypoint resolves this scientifically.*
  >
  > *In Step 4, Waypoint executes a factorial replay grid across all combinations: model v1 and v2 against both prompt variants.*
  >
  > *Replays run in complete isolation: zero documents are written to live telemetry. Waypoint computes Shapley values from cooperative game theory: model bump receives 50% blame, prompt removal receives 50% blame, and decoy configuration changes receive 0%. As a caveat: Shapley values represent experimental blame shares over replay runs, not physical proof of causation."*

---

### 4:00 – 4:30 | Episodic Memory & Incident Resolution (Step 5)
- **Visual**: Browser on `/incidents` or `/guide` (Step 5: Resolve & Save).
- **Action**: Click "Resolve & Save". Navigate to `/lessons` to inspect the newly created lesson.
- **Narration**:
  > *"In Step 5, the engineer resolves the incident and records the fix into episodic memory.*
  >
  > *Waypoint stores the violated contract rule, the culprit axes, and generates 1024-dimension embeddings via the MongoDB Atlas Voyage-4 API.*
  >
  > *Past incidents are no longer lost in Slack or Jira tickets—they become indexed, searchable institutional memory inside MongoDB."*

---

### 4:30 – 5:15 | Beat 4: Preflight Regression Guard — The Finale (Step 6)
- **Visual**: Browser on `/guide` (Step 6: Preflight v3), then `/preflight`.
- **Action**: Click "Preflight v3". Point out the bold red **`Verdict: BLOCK`** banner and the structural citation.
- **Narration**:
  > *"Here is the finale: two weeks later, another developer attempts to ship model v3 without the camelCase formatting rule.*
  >
  > *Before code reaches production, they run a preflight check from the dashboard, API, or MCP tool.*
  >
  > *Waypoint replays the candidate context against test inputs, observes 60 of 60 runs violating the contract, and recalls the lesson we just saved in Step 5.*
  >
  > *The result: **`Verdict: BLOCK`**. Waypoint stops the deployment and cites our exact Step-5 lesson with a structural match on the same rule and culprit axes. Conversely, when we test a harmless configuration change like chunk size, preflight evaluates zero violations and issues a clean `PASS`."*

---

### 5:15 – 5:50 | Hard Cases & System Resilience
- **Visual**: Browser at `/hard-cases`.
- **Action**: Click each hard case button: 50 Concurrent Duplicates, Invalid Event 422, No Baseline 409, Inconclusive Sample.
- **Narration**:
  > *"Waypoint is engineered for edge cases. On the Hard Cases page:*
  > - *50 concurrent duplicate calls result in exactly 1 stored document and 49 ignored.*
  > - *Malformed events are rejected with 422 validation errors.*
  > - *Preflight without a baseline safely halts with HTTP 409.*
  > - *Small sample sizes use Wilson confidence intervals to report 'inconclusive' rather than guessing."*

---

### 5:50 – 6:15 | MongoDB Features & Index Verification
- **Visual**: Terminal or `/debug` showing index explain output and collection stats.
- **Action**: Highlight the `IXSCAN` explain plan on `events` and TTL index on sandboxes.
- **Narration**:
  > *"Under the hood, Waypoint relies deeply on MongoDB:*
  > - *Change Streams for sub-second reactive detection and live UI streaming.*
  > - *Aggregation pipelines for baseline invariant mining.*
  > - *Atlas Vector Search with Voyage-4 for semantic lesson retrieval.*
  > - *Compound and TTL indexes ensuring sub-millisecond query execution and automated sandbox eviction."*

---

### 6:15 – 6:30 | Limits & Conclusion
- **Visual**: Return to main dashboard. Show clean, responsive interface.
- **Narration**:
  > *"To be fully transparent: our evaluation set is small (24 queries), and on the free Voyage API, high bursts gracefully fall back to in-app lexical search.*
  >
  > *Waypoint turns MongoDB into an active safety black box for LLM agents—recording histories, isolating culprits, and guarding production against repeat failures. Thank you."*

