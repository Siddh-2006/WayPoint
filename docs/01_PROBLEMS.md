# Problems: Silent Failures Caused by Invisible Changes

## The common pattern

All ten problems below share one shape:

1. Something **outside the code** changes (a model, prompt, setting, data source or dependency).
2. **No error is raised.** Requests succeed, pages load, tests mostly pass.
3. The **behavior is wrong**, and the harm shows up later or somewhere else.
4. The team cannot answer: *what changed, which change did it, have we seen this before?*

The three questions are the heart of the problem. We call it **Change Amnesia**.

---

## Ten real-world problems

### 1. AI agent sends slightly wrong arguments to a tool
- **Scenario:** An invoice agent calls a "create invoice" tool.
- **What changed:** Model upgrade plus a prompt edit, shipped together.
- **What broke silently:** The model renames `invoiceId` to `invoice_id`. The tool accepts it. Records are filed under the wrong key.
- **Why it is hard to trace:** Each change looks harmless alone. The failure only appears when both are present.

### 2. Search-based answers get worse after a data refresh
- **Scenario:** A support bot answers from a company knowledge base.
- **What changed:** The embedding model or the document chunk size.
- **What broke silently:** The website works, but answers become vague or irrelevant.
- **Why it is hard to trace:** Nobody saved which index settings were live on which day.

### 3. Tests fail randomly after a dependency update
- **Scenario:** A team merges a library bump and an unrelated feature on the same day.
- **What changed:** Dependency version plus new code.
- **What broke silently:** Tests fail one run in five. People click "rerun" until green.
- **Why it is hard to trace:** Is it a real bug, a timing issue, or the library? Nobody has the evidence.

### 4. A prompt edit changes what a customer bot promises
- **Scenario:** A support assistant is edited to sound friendlier.
- **What changed:** One sentence in the system prompt.
- **What broke silently:** The bot starts offering refunds it should not.
- **Why it is hard to trace:** The edit looks like a tone change. The policy effect shows up in a few conversations out of thousands.

### 5. A settings push changes behavior for some users only
- **Scenario:** A feature flag or configuration value is rolled out to a slice of traffic.
- **What changed:** A configuration value.
- **What broke silently:** One group of users sees wrong results. Averages look fine.
- **Why it is hard to trace:** Overall health charts hide a problem in a subset.

### 6. An API field changes meaning or becomes optional
- **Scenario:** A provider makes a field nullable, or changes its unit.
- **What changed:** The data returned by another team's service.
- **What broke silently:** A consumer app mishandles empty values and produces wrong totals.
- **Why it is hard to trace:** A schema comparison shows *what* changed but not *who* gets hurt or *when* damage began.

### 7. A data pipeline's input quietly changes
- **Scenario:** An upstream table changes how a column is filled.
- **What changed:** The meaning of the column.
- **What broke silently:** Dashboards and model scores drift. Nothing errors.
- **Why it is hard to trace:** The pipeline ran successfully every night.

### 8. A tool definition changes under an agent
- **Scenario:** A tool's parameter is renamed or its description reworded.
- **What changed:** The tool schema the agent reads.
- **What broke silently:** The agent calls the tool with old parameter names, or picks the wrong tool.
- **Why it is hard to trace:** The tool still responds, so no failure is logged.

### 9. A model provider updates behind the same name
- **Scenario:** The model name in your config stays the same, but the behavior shifts.
- **What changed:** The provider's model version (outside your control).
- **What broke silently:** Output format, tone or accuracy changes overnight.
- **Why it is hard to trace:** Your own code and settings did not change at all.

### 10. One service changes its output and a downstream service misreads it
- **Scenario:** Two agents or microservices pass data to each other.
- **What changed:** The first service starts formatting its output differently.
- **What broke silently:** The second service reads it wrongly and the error spreads.
- **Why it is hard to trace:** The failure appears far from the cause, and both services report success.

---

## What we ARE solving

**Unexplained behavior changes** where the code is valid and no error is raised, and where the answer needs **history, comparison and memory**:

- Capturing exactly which versions and settings were live for every run
- Noticing that behavior drifted, using rules learned from good runs
- Finding which change, or combination of changes, is responsible
- Remembering what happened and how it was fixed
- Warning before the same kind of change ships again

## What we are NOT solving

These are real problems, but they are handled better by other kinds of tools, and mixing them in would weaken our focus:

| Not in scope | Why |
|---|---|
| Syntax errors and compile failures | Caught before the code runs |
| Crashes and stack traces | Standard error tracking already does this well |
| Hardware and network outages | Infrastructure monitoring covers this |
| Memory leaks and slow servers | Performance monitoring covers this |
| Security vulnerabilities | Specialized scanners cover this |
| AI model training failures | A different stage of the pipeline |
| Changes made outside what Waypoint is connected to | We cannot see them. We say so openly. |

## What the prototype demonstrates directly

The working prototype demonstrates problems **1 and 8** end to end, using a **simulated** invoice agent so results are repeatable. The same record-detect-explain-remember-warn flow applies to the other problems, but each one would need its own small connector to feed Waypoint its runs and settings. That is future work, and we say so plainly.
