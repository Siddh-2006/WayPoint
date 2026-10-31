# Waypoint — Judge Q&A Preparation (15 Core Questions)

> [!TIP]
> Each answer is structured as 2–3 concise, honest, and technically rigorous sentences.
> Rehearse questions 1, 3, 4, 6, and 8 out loud before the live presentation.

---

### 1. Which embedding model do you use, and how is it called?
> *"We use MongoDB's official Embedding API serving Voyage AI's `voyage-4` model with 1024 dimensions. Requests are sent directly over HTTPS using an Atlas Model API key. Startup dimension verification ensures embedding sizes match database vector index definitions."*

### 2. Why is incident detection deterministic rather than LLM-based?
> *"LLM-based evaluators introduce nondeterminism, latency, and hallucinated false alarms into production pipelines. Waypoint detects regressions using deterministic schema comparisons against structural contracts mined via MongoDB aggregation pipelines (`$project`, `$objectToArray`, `$group`)."*

### 3. What do Shapley values prove, and what do they NOT prove?
> *"Shapley values calculate axiomatic, fair blame shares over the observed violation rates across a $2^k$ factorial replay grid, apportioning credit even when model and prompt changes interact. They do not constitute mathematical proof of physical causality; they quantify empirical blame sharing across controlled replay experiments."*

### 4. How does Waypoint handle duplicate events during network retries?
> *"Waypoint uses deterministic content-hashed event IDs (`runId:seq` or input SHA-256) backed by a MongoDB unique index on `_id`. High-concurrency retries catch MongoDB error code 11000 and return HTTP 201 with `duplicate_ignored`, guaranteeing exactly one document is stored without dropping batch execution."*

### 5. Why does the replay engine never touch or corrupt live production data?
> *"Replays execute within an isolated, ephemeral sandbox that stores zero documents in the production `events` or `runs` collections. Furthermore, tool executions are intercepted and mocked so external side-effects (such as database writes or API charges) are never triggered."*

### 6. What does the "simulated agent" mean, and why did you use it?
> *"The simulated invoice agent is a deterministic model driven by a seeded pseudo-random number generator (Mulberry32) with a planted regression condition. We chose this design deliberately so hackathon judges can experience instant, 100% reproducible evaluations with zero flakiness, latency, or API spend."*

### 7. Why is MongoDB specifically suited for Waypoint?
> *"MongoDB provides polymorphic document storage for variable LLM payloads, Change Streams for sub-second reactive incident detection, Aggregation Pipelines for schema mining, and native Atlas Vector Search for episodic memory retrieval. This eliminates the need for separate Redis queues, PostgreSQL databases, and Pinecone vector stores."*

### 8. What is explicitly NOT covered or built in this project?
> *"Waypoint is not an autonomous code patcher or an automated canary traffic manager; it is a diagnostic detection, attribution, and preflight review tool with a human in the loop. Additionally, contracts are mined from a designated baseline version rather than continuously from unvetted live traffic."*

### 9. What happens when the embedding provider rate limits?
> *"If the Voyage API returns HTTP 429 during high traffic bursts, Waypoint catches the error and automatically falls back to in-app lexical token-overlap matching. The dashboard surfaces a transparent note stating 'semantic search temporarily unavailable,' and preflight structural guards continue operating without interruption."*

### 10. What would you build next with another month of engineering?
> *"We would implement distributed document leases in MongoDB to support horizontal multi-instance scaling, expand invariant mining to multi-step relational invariants across chained tool calls, and support automated regression test generation from resolved episodic lessons."*

### 11. Which third-party libraries did you use, and did you copy any code?
> *"Waypoint is an original TypeScript codebase built using Fastify (HTTP), Zod (validation), MongoDB Node driver (database), Diff (lexical context diffing), React (UI), and Recharts (data visualization). Every dependency is permissively licensed (MIT, Apache-2.0, BSD-3-Clause, ISC), and no GPL or unlicensed code was used."*

### 12. How were AI coding assistants used in this project?
> *"We utilized Google DeepMind's Antigravity assistant for drafting test scripts, boilerplate schemas, and document formatting. All architectural decisions, mathematical Shapley calculations, MongoDB aggregation queries, and debugging passes were reviewed, verified, and run by the human team."*

### 13. How are invariant contracts mined without human specification?
> *"Waypoint runs a MongoDB aggregation pipeline over successful baseline runs, converting tool argument objects into key-value pairs via `$objectToArray`, unwinding the entries, and grouping by key and BSON type. Any key-type pair appearing in at least 98% of baseline executions is promoted into the active contract."*

### 14. How does Waypoint avoid change stream cursor exhaustion on Atlas M0?
> *"Instead of opening a new MongoDB change stream for every connected browser tab, Waypoint maintains a single shared change stream cursor on the `runs` collection and fans out events in-memory to connected SSE clients. This bounds active database connections to 1 regardless of how many users view the dashboard."*

### 15. Why was the preflight cosine threshold calibrated to 0.48?
> *"We split our 24-query evaluation set into disjoint calibration ($n=12$) and held-out ($n=12$) sets. Setting `LESSON_MIN_SCORE = 0.48` cleanly separates true incidents from benign queries, achieving 0.0% false warnings on negative controls while preserving 57% strong-tier warning recall and 100% rank-only Hit@3 on held-out tests."*

