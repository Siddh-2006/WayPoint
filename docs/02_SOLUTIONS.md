# Solutions: How Waypoint Handles Each Problem

## The one pattern behind every solution

```
Record  ->  Detect  ->  Explain  ->  Remember  ->  Warn
(what ran)  (it drifted) (which change) (lesson)    (before next change)
```

Every problem in `01_PROBLEMS.md` is attacked with the same five steps. Only the "what we record" changes.

**Honesty note:** the prototype runs problems **1 and 8** end to end on a simulated agent. The rest use the same engine but need a connector (a small piece of code that sends that system's runs and settings to Waypoint).

---

## Problem 1 and 8: Agent sends wrong arguments (demonstrated)

1. **Record.** Each run stores a snapshot of model, prompt, settings and tool definitions. A fingerprint (hash) of the snapshot identifies the version.
2. **Detect.** From good runs, Waypoint learns a rule: "`create_invoice` always includes `invoiceId`." A run that sends `invoice_id` instead breaks the rule. The message says exactly that: *key `invoiceId` missing; found `invoice_id`*.
3. **Explain.** Waypoint finds the changes between the good and bad version (model, prompt, setting). It re-runs the same inputs under every combination of those changes. Result: model alone is fine, prompt alone is fine, both together fail. Blame is split about 50/50, and the unrelated setting gets about 0.
4. **Remember.** When the team resolves it, the symptom, culprits and fix are saved as a lesson.
5. **Warn.** Before the next model upgrade, a pre-change check replays the inputs and looks up similar lessons: "A previous upgrade renamed keys. Fix was X."

## Problem 2: Search answers get worse after a refresh

- **Record:** the embedding model, chunk size and index settings as part of each version snapshot.
- **Detect:** rules over retrieved results (for example, "answers always cite at least one source" or "retrieved chunk length stays in range").
- **Explain:** the same combination re-run shows whether the embedding change, the chunk change or both reduced quality.
- **Remember and warn:** the lesson says which setting hurt and how it was fixed.

## Problem 3: Random test failures after a dependency bump

- **Record:** dependency versions per test run as part of the snapshot.
- **Detect:** failure *rate* per version, not single failures. Small samples are labeled "inconclusive" instead of blamed.
- **Explain:** compare the bump alone vs the code change alone vs both.
- **Remember and warn:** if a library bump caused flakiness before, the next bump is flagged.

## Problem 4: A prompt edit changes what a bot promises

- **Record:** the exact prompt text, with a line-level diff against the previous version.
- **Detect:** a rule such as "responses never contain refund approvals above policy" turns policy into a checkable contract.
- **Explain:** the prompt line change is isolated as the unit responsible.
- **Warn:** future prompt edits are replayed against saved conversations before shipping.

## Problem 5: Settings push hurts a subset of users

- **Record:** the setting values live at the time of each run.
- **Detect:** violation rate per version and per group, so a small group's failures are not averaged away.
- **Explain:** isolate which setting key is responsible.

## Problem 6: An API field becomes nullable or changes meaning

- **Record:** the contract the consumer saw, with a timestamp.
- **Detect:** type and presence rules over responses (for example, "amount is always a number").
- **Explain:** show the first version where the rule started breaking.
- **Note:** identifying *which consumers* are affected needs a consumer map, which is future work.

## Problem 7: A data pipeline input quietly changes

- **Record:** source settings and schema fingerprints per pipeline run.
- **Detect:** value-range and type rules mined from healthy runs.
- **Explain:** link the first drifting run to the version that introduced it.

## Problem 9: A model provider updates behind the same name

- **Record:** the same snapshot, plus a fixed set of reference inputs replayed regularly.
- **Detect:** if the same version fingerprint starts producing more rule violations, the change came from outside, and Waypoint says so. That is evidence you did not change anything.
- **Note:** regular replay against a live provider is future work for this prototype.

## Problem 10: One service's output breaks the next

- **Record:** both services' steps in one timeline using shared run identifiers.
- **Detect:** rules on the handoff payload.
- **Explain:** the first step in the timeline where behavior diverges is shown, so blame lands at the origin and not at the symptom.

---

## Why this is more than a log viewer

| A normal log viewer | Waypoint |
|---|---|
| Shows what happened | Shows what *changed* and who is responsible |
| Needs a human to search | Learns rules and flags drift itself |
| Forgets after the incident | Stores a lesson and uses it next time |
| One bad run at a time | Compares groups of runs and says how sure it is |

## What the developer experiences

1. A live dashboard lights up the moment a version starts misbehaving.
2. The incident page lists exact changes and the exact rule broken.
3. One click runs the experiment grid and shows who is to blame.
4. Resolving saves a lesson.
5. Next time a similar change is proposed, the pre-change check says: **block**, **warn** or **pass**, with reasons.