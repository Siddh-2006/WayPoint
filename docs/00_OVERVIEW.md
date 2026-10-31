# Waypoint: The Whole Idea in Plain Language

> **Waypoint is a flight recorder for software changes.** It remembers every prompt, model and setting change, detects when behavior quietly goes wrong, shows which change is to blame, and warns you before you repeat a past mistake.

---

## 1. The story

A company runs an AI agent that reads invoices and creates records in an accounting system. It works well for months.

On Monday a developer ships **two small changes together**:
1. The AI model is upgraded to a newer version.
2. One line in the instructions (the "prompt") is edited.

Nothing crashes. Every request still returns "success". But the new model now writes the field name `invoice_id` instead of `invoiceId`. The accounting system accepts the record and files it wrongly. Wrong data piles up for days.

When someone finally notices, the team asks three questions and cannot answer them:

1. **What changed** between the last good day and the first bad day?
2. **Which change caused it?** Neither change looks harmful alone. Only the *combination* breaks things.
3. **Have we seen this before?** Last quarter a similar upgrade caused a similar problem. Nobody remembers how it was fixed.

We call this **Change Amnesia**: the system forgot its own history.

---

## 2. Why this problem exists now

Software used to break loudly: a crash, an error message, a bad commit. Today much of a program's behavior lives **outside the code**: the AI model version, the prompt text, configuration values, search settings, library versions. When one of those changes, the code is untouched and no error appears. The program just behaves differently.

Git tracks code. Error trackers track crashes. **Nothing keeps a connected memory of everything else.**

---

## 3. What Waypoint does (five steps)

| Step | What happens | In simple words |
|---|---|---|
| **Record** | Every run is logged with an exact snapshot of the model, prompt and settings it used | "Write down what was running" |
| **Detect** | Rules learned from good runs flag runs that behave differently | "Notice when something quietly goes wrong" |
| **Explain** | The failing setup is re-run under every combination of the changes, and blame is shared out fairly | "Find which change, or which pair of changes, did it" |
| **Remember** | Resolved incidents are saved as lessons | "Write down what we learned" |
| **Warn** | Before a new change ships, Waypoint tests it and checks past lessons | "Stop us from repeating a mistake" |

---

## 4. Why we built it this way

- **Detection is plain code and database queries, not AI guessing.** Results are repeatable and can be checked. An AI model is only used (as an optional extra) to write a readable explanation of results that were already computed.
- **We compare rules, not exact wording.** AI output varies run to run, so we check things like "this tool call must always include `invoiceId`" and measure how *often* a rule is broken.
- **We say "not sure" when the evidence is weak.** Small samples give an "inconclusive" label instead of a confident guess.
- **Everything lives in one MongoDB database**: runs, versions, rules, experiments and lessons. That keeps the system simple and fast to query.

---

## 5. Why this is a good fit for the hackathon track

The track asks for a developer tool that stores history in MongoDB and turns it into a **diagnosis, comparison, warning or action**. Waypoint does all four:

- **Diagnosis**: the culprit analysis
- **Comparison**: good version vs bad version, change by change
- **Warning**: live incident alerts and pre-change checks
- **Action**: resolve an incident and store the lesson

---

## 6. What Waypoint is not

- It does **not** replace error monitoring, linters or infrastructure monitors. Crashes, syntax errors, outages and memory leaks are out of scope.
- It does **not** see changes made outside the system it is connected to.
- It does **not** prove causation. It shares out credit based on repeatable experiments and says how confident it is.
- The demo agent is **simulated** so results are reproducible. It is clearly labeled as simulated everywhere.

---

## 7. How to read the rest of these docs

| File | What it explains |
|---|---|
| `01_PROBLEMS.md` | Ten real-world problems of this type, and exactly what we do and do not solve |
| `02_SOLUTIONS.md` | How Waypoint handles each of those ten problems |
| `03_TECHNICAL_APPROACH.md` | Architecture, data flow and algorithms |
| `04_MONGODB_USAGE.md` | Every MongoDB feature we use and why |
| `05_FEATURES.md` | All features in order, each connected to the next |
