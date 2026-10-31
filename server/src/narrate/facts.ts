/**
 * server/src/narrate/facts.ts
 *
 * Structured fact generation for evidence-cited LLM narration.
 * Gathers and formats verified ground truth from:
 *   - Live incident record (rate, Wilson CI, violations, context diffs)
 *   - Replay factorial attribution (culprit units, Shapley values, interaction)
 *   - Episodic memory lessons (prior regressions, symptoms, fixes)
 *
 * All user text is strictly sanitized and truncated to <= 120 characters.
 */

export interface FactItem {
  id: string; // "F1", "F2", etc.
  label: string;
  text: string;
  numbers: string[]; // Numbers/percentages present in this fact for citation verification
  data?:undefined| Record<string, unknown>;
}

export function truncateText(text: unknown, maxLen = 120): string {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1) + '…';
}

function extractNumbersFromText(text: string): string[] {
  // Matches integers, decimals, and percentages e.g. "100%", "0.50", "20", "95%"
  const matches = text.match(/\b\d+(?:\.\d+)?%?\b/g);
  return matches ? Array.from(new Set(matches)) : [];
}

export function buildFacts(
  incident: {
    _id?: unknown;
    id?: string;
    projectId: string;
    rate: number;
    baselineHash: string;
    badHash: string;
    changes?: Array<{ axis: string; path: string; summary: string }>;
    violationSummary?: Record<string, number>;
    evidenceRunIds?: string[];
  },
  experiment?: {
    status?: string;
    culprit?: { units: string[]; interaction: boolean };
    shapley?: Record<string, number>;
    method?: string;
  } | null,
  lessons?: Array<{
    lessonId: string;
    score: number;
    lesson: { symptom: string; fix: string };
  }> | null,
): FactItem[] {
  const facts: FactItem[] = [];
  const incId = String(incident.id ?? incident._id ?? 'unknown');

  // F1: Incident failure rate and scope
  const pct = (incident.rate * 100).toFixed(0);
  const f1Text = `Incident ${incId} on project ${incident.projectId} detected ${pct}% contract violation rate across ${
    incident.evidenceRunIds?.length ?? 1
  } runs.`;
  facts.push({
    id: 'F1',
    label: 'Incident Rate',
    text: f1Text,
    numbers: extractNumbersFromText(f1Text),
    data: { incidentId: incId, rate: incident.rate, project: incident.projectId },
  });

  // F2: Root cause context changes
  const changeSummaries = (incident.changes ?? [])
    .map((c) => truncateText(`${c.axis}: ${c.summary}`, 100))
    .join('; ');
  const f2Text = `Context changed from baseline ${incident.baselineHash.slice(0, 8)} to regression ${incident.badHash.slice(
    0,
    8,
  )} with modifications: ${changeSummaries || 'none detected'}.`;
  facts.push({
    id: 'F2',
    label: 'Context Changes',
    text: f2Text,
    numbers: extractNumbersFromText(f2Text),
    data: { changesCount: incident.changes?.length ?? 0 },
  });

  // F3: Replay attribution & Shapley values
  if (experiment && experiment.status === 'done') {
    const culprits = experiment.culprit?.units.join(', ') || 'inconclusive';
    const shapleyEntries = Object.entries(experiment.shapley ?? {})
      .map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`)
      .join(', ');
    const f3Text = `Replay factorial attribution confirmed culprit unit(s): [${culprits}] with Shapley values: ${
      shapleyEntries || 'none'
    } (interaction=${experiment.culprit?.interaction ? 'true' : 'false'}).`;
    facts.push({
      id: 'F3',
      label: 'Replay Blame',
      text: f3Text,
      numbers: extractNumbersFromText(f3Text),
      data: { culprits, shapley: experiment.shapley },
    });
  } else {
    const f3Text = `Replay factorial attribution pending or not yet computed for this incident.`;
    facts.push({
      id: 'F3',
      label: 'Replay Status',
      text: f3Text,
      numbers: extractNumbersFromText(f3Text),
    });
  }

  // F4: Contract violation breakdown
  const violationEntries = Object.entries(incident.violationSummary ?? {})
    .map(([rule, count]) => `${truncateText(rule, 60)} (${count} times)`)
    .join(', ');
  const f4Text = `Contract checks violated: ${violationEntries || 'missing required tool parameters'}.`;
  facts.push({
    id: 'F4',
    label: 'Violations',
    text: f4Text,
    numbers: extractNumbersFromText(f4Text),
    ...(incident.violationSummary ? { data: incident.violationSummary } : {}),
  });

  // F5+: Recalled lessons from episodic memory
  if (lessons && lessons.length > 0) {
    lessons.slice(0, 2).forEach((l, idx) => {
      const fid = `F${5 + idx}`;
      const symptom = truncateText(l.lesson.symptom, 100);
      const fix = truncateText(l.lesson.fix, 100);
      const scoreStr = l.score.toFixed(3);
      const fText = `Prior episodic lesson ${l.lessonId} [strong match, score ${scoreStr}] noted symptom "${symptom}" with remediation: "${fix}".`;
      facts.push({
        id: fid,
        label: `Prior Lesson (${l.lessonId})`,
        text: fText,
        numbers: extractNumbersFromText(fText),
        data: { lessonId: l.lessonId, score: l.score },
      });
    });
  }

  return facts;
}
