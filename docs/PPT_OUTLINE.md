# Waypoint — Presentation Deck Outline (11 Slides)

> [!NOTE]
> Structure: Exactly 11 slides, maximum 3 bullets per slide, with concrete visual instructions and realistic speaker notes.
> All performance metrics and claims are strictly synchronized with [`docs/MEASURED_FACTS.md`](./MEASURED_FACTS.md).

---

### Slide 1: Title Slide
- **Title**: Waypoint: Failure Attribution & Episodic Preflight Guard for LLM Agents
- **Bullets**:
  - A flight recorder and regression guard for autonomous software changes.
  - Built with MongoDB (Change Streams, Aggregations, Vector Search, Partial Indexes).
  - Open-source, deterministic core with human-in-the-loop review.
- **Visual**: Waypoint logo, subtitle, team names, and GitHub badge.
- **Speaker Note**:
  > *"Hello judges. We're presenting Waypoint, a flight recorder and episodic preflight guard for production AI agents, built natively on MongoDB."*

---

### Slide 2: The Problem — Silent Agent Regressions
- **Title**: The Problem: Silent Regressions in Production Agents
- **Bullets**:
  - LLM agents return HTTP 200 while silently corrupting tool parameters or schemas.
  - Multiple simultaneous updates (model, prompt, configs) obscure the true failure culprit.
  - Without institutional memory, teams repeatedly deploy the same broken patterns.
- **Visual**: Diagram showing an agent returning HTTP 200 with `invoice_id` (snake_case) breaking a downstream microservice expecting `invoiceId` (camelCase).
- **Speaker Note**:
  > *"When developers update an agent's prompt and model at the same time, traditional unit tests fail to catch subtle contract drifts. Downstream pipelines crash, and developers waste hours arguing over whether the prompt or the model caused the failure."*

---

### Slide 3: What Waypoint Solves vs. Does Not Solve
- **Title**: System Scope & Explicit Boundaries
- **Bullets**:
  - **Solves**: Invariant contract mining, real-time silent failure detection, Shapley blame shares, and episodic preflight blocking.
  - **Does NOT do**: Autonomous code patching or continuous unvetted schema mining.
  - **No automated canaries**: Detection and review guard with an engineer resolving incidents.
- **Visual**: Comparison table: Solved Core vs. Out-of-Scope non-goals.
- **Speaker Note**:
  > *"We are rigorous about our scope: Waypoint records telemetry, attributes blame across interacting factors, and warns before repeat mistakes. It is an active safety black box, not an unguided auto-patcher."*

---

### Slide 4: The 5-Step Solution Flow
- **Title**: End-to-End Reliability Lifecycle
- **Bullets**:
  - **Record**: Ingest tool calls, context snapshots, and execution traces idempotently into MongoDB.
  - **Detect & Explain**: Mine baseline contracts; run factorial replays to compute Shapley blame shares.
  - **Remember & Warn**: Store lessons in episodic memory ($vectorSearch); preflight-block candidate regressions.
- **Visual**: Linear process flow diagram showing: Record $\to$ Mine $\to$ Detect $\to$ Attribute $\to$ Preflight Guard.
- **Speaker Note**:
  > *"Waypoint organizes reliability into a five-step lifecycle: from raw telemetry ingestion to factorial blame attribution and episodic preflight interception."*

---

### Slide 5: System Architecture & Data Flow
- **Title**: Modern, Single-Service Reactive Architecture
- **Bullets**:
  - Fastify server + React SPA packaged into a single production Docker container.
  - Singleton MongoDB Change Stream with in-memory SSE fan-out for sub-second live telemetry.
  - Ephemeral replay sandbox executes factorial grids without polluting production history.
- **Visual**: Architecture diagram showing Agent SDK $\to$ Fastify $\to$ MongoDB $\to$ Change Stream Detector $\to$ Replay Grid $\to$ Episodic Memory $\to$ Dashboard.
- **Speaker Note**:
  > *"Here is the architecture. Ingested events are validated with Zod, sanitized of secrets, and stored in MongoDB. A singleton change stream feeds both our real-time detector and live dashboard stream, avoiding cursor exhaustion."*

---

### Slide 6: Native MongoDB Capabilities
- **Title**: Deep MongoDB Platform Utilization
- **Bullets**:
  - **Change Streams**: Real-time sliding-window failure rate tracking and live SSE broadcast.
  - **Aggregation Pipelines**: Mined structural invariant contracts (`$match`, `$project`, `$group`).
  - **Vector Search & Indexing**: 1024-dim Atlas Voyage-4 search, partial unique indexes for single-incident deduplication, and TTL indexes.
- **Visual**: Table mapping MongoDB features (Change Streams, Aggregations, Vector Search, Partial Unique Index, TTL) to Waypoint components.
- **Speaker Note**:
  > *"Waypoint is built natively around MongoDB. We leverage Change Streams for reactive detection, Aggregations for contract inference, Vector Search with Voyage-4 for memory recall, and partial unique indexes to eliminate duplicate incident storms."*

---

### Slide 7: Interactive Demo Story (Screenshots)
- **Title**: Live Demo: The Invoice Agent Story
- **Bullets**:
  - **Step 2 Baseline**: 20/20 clean runs; contract mined for `create_invoice`.
  - **Step 3 Bad Deploy**: Model v2 + missing camelCase prompt triggers silent failures and opens incident.
  - **Step 4 Replay Matrix**: 4-cell factorial grid isolates 50% model / 50% prompt blame.
- **Visual**: **Screenshot required**: Web dashboard showing Step 4 Replay Grid with the 4-cell matrix and Shapley attribution bar chart from `/guide`.
- **Speaker Note**:
  > *"In our live demo, we test an invoice extraction agent. When a bad deploy is pushed, Waypoint's factorial replay evaluates all combinations in an isolated sandbox, proving that both the model bump and prompt edit shared blame equally."*

---

### Slide 8: The Finale — Episodic Preflight Guard (Screenshot)
- **Title**: The Finale: Preflight Intercepts Proposed v3
- **Bullets**:
  - Engineer resolves the incident and stores the fix into MongoDB episodic memory.
  - Two weeks later, a candidate model v3 update is submitted for preflight check.
  - Waypoint replays the change, catches 60/60 violations, and issues **`Verdict: BLOCK`** citing the Step 5 lesson.
- **Visual**: **Screenshot required**: Web dashboard showing the red `Verdict: BLOCK` card from Step 6 of `/guide`, displaying the structural citation to the saved incident lesson.
- **Speaker Note**:
  > *"Here is the crowning moment: when a developer attempts to deploy model v3, preflight replays the change, recalls our saved lesson from episodic memory, and halts deployment with a BLOCK verdict and exact structural citation."*

---

### Slide 9: Measured Benchmark Results
- **Title**: Empirical Results (Single Source of Truth)
- **Bullets**:
  - **Concurrency**: 1,000 duplicate events $\to$ exactly 1 stored doc; 200 context POSTs $\to$ exactly 1 doc.
  - **Shapley Efficiency**: Mathematical axiom error $\lvert \sum \phi_i - \Delta v \rvert = 1.11 \times 10^{-16}$.
  - **Recall Evaluation ($n=12$ held-out)**: 100% rank-only Hit@3, 57.1% strong-tier Hit@3, 0% false warnings.
- **Visual**: Comparison bar chart or clean results table from `docs/MEASURED_FACTS.md`.
- **Speaker Note**:
  > *"Our results are strictly measured: 1,000 concurrent duplicate ingest calls yield exactly 1 document. On held-out retrieval evaluation, semantic vectors achieve 100% rank-only Hit@3 and 0% false warnings on negative control queries."*

---

### Slide 10: Known Limitations & Engineering Honesty
- **Title**: Known Limitations & Trade-offs
- **Bullets**:
  - **Attribution Caveat**: Shapley values reflect experimental blame shares over replays, not physical proof of causality.
  - **Evaluation Corpus**: Retrieval benchmark is small ($n = 24$ total, $n = 12$ held-out).
  - **API Rate Limits**: Free Voyage trial limit (3 RPM) triggers graceful fallback to in-app lexical matching during high bursts.
- **Visual**: Clean callout box highlighting engineering trade-offs and safety fallbacks.
- **Speaker Note**:
  > *"We believe in total engineering honesty: Shapley attribution represents blame shares over replay simulations. Furthermore, on free-tier rate limits, our system gracefully falls back to lexical matching to avoid dropping traffic."*

---

### Slide 11: Impact, Deployment & Future Work
- **Title**: Production Deployment & Roadmap
- **Bullets**:
  - **Deployed Live**: Available as a single Docker container on cloud hosting with zero client-side credentials.
  - **Developer Experience**: Accessible via REST API, interactive web dashboard, and Model Context Protocol (MCP) server.
  - **Future Roadmap**: Distributed cross-instance leases, multi-tool relational invariants, and expanded enterprise eval suites.
- **Visual**: Deployed live URL, GitHub repository QR code, and MCP client terminal preview.
- **Speaker Note**:
  > *"Waypoint is live today, tested end-to-end, and ready for judges to explore without logging in. Thank you, and we welcome your questions."*

