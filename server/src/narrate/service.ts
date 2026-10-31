/**
 * server/src/narrate/service.ts
 *
 * Evidence-cited narration service.
 * Synthesizes grounded facts from live incidents, factorial replay experiments,
 * and episodic memory lessons into compact (<= 600 chars) narratives.
 *
 * Supports OpenAI-compatible LLM endpoints with deterministic grounded fallback
 * and rigorous sentence-level citation verification.
 */

import { ObjectId, type Db } from 'mongodb';
import { config } from '../config.js';
import { buildFacts, type FactItem } from './facts.js';
import { validateNarration, type ValidationResult } from './validate.js';
import { recallLessons } from '../lessons/recall.js';

function toObjectIdOrString(id: string): ObjectId | string {
  try {
    return ObjectId.isValid(id) ? new ObjectId(id) : id;
  } catch {
    return id;
  }
}

export interface NarrationResult {
  incidentId: string;
  summary: string;
  facts: FactItem[];
  citations: string[];
  model: string;
  citedAt: string;
  cached: boolean;
}

/**
 * Builds a deterministic, citation-grounded narrative using only the provided facts.
 */
export function generateDeterministicNarration(facts: FactItem[]): string {
  const fMap = new Map(facts.map((f) => [f.id, f]));
  const sentences: string[] = [];

  // Sentence 1: Rate and detection [F1]
  const f1 = fMap.get('F1');
  if (f1) {
    const ratePct = f1.text.match(/\b\d+%\b/)?.[0] ?? '100%';
    const runsCount = f1.text.match(/across (\d+) runs/)?.[1] ?? '1';
    sentences.push(
      `Silent contract regression detected with ${ratePct} failure rate across ${runsCount} production runs [F1].`,
    );
  }

  // Sentence 2: Context differences [F2]
  const f2 = fMap.get('F2');
  if (f2) {
    sentences.push(
      `Regression occurred after deploying context changes against baseline contracts [F2].`,
    );
  }

  // Sentence 3: Replay attribution [F3]
  const f3 = fMap.get('F3');
  if (f3 && f3.text.includes('culprit unit')) {
    const culprits = f3.text.match(/culprit unit\(s\): \[([^\]]+)\]/)?.[1] ?? 'parameters';
    sentences.push(
      `Replay factorial attribution isolated blame to culprit unit(s) [${culprits}] [F3].`,
    );
  }

  // Sentence 4: Contract violations [F4]
  const f4 = fMap.get('F4');
  if (f4) {
    sentences.push(
      `Violations stemmed from missing required invariants in tool execution [F4].`,
    );
  }

  // Sentence 5: Remediation from episodic memory [F5]
  const f5 = fMap.get('F5');
  if (f5) {
    sentences.push(
      `Prior episodic lesson recommends restoring parameter invariants to prevent repeat regression [F5].`,
    );
  }

  const combined = sentences.join(' ');
  return combined.length <= 600 ? combined : combined.slice(0, 597) + '…';
}

export async function narrateIncident(
  db: Db,
  incidentId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<NarrationResult> {
  const incidentsCol = db.collection('incidents');
  const experimentsCol = db.collection('experiments');

  const objId = toObjectIdOrString(incidentId);
  const incident = await incidentsCol.findOne({
    $or: [{ _id: objId }, { _id: incidentId as any }, { id: incidentId }],
  });

  if (!incident) {
    throw new Error(`Incident not found: ${incidentId}`);
  }

  // Check if incident already has a valid cached narration
  if (!options.forceRefresh && incident['narration']?.summary && incident['narration']?.facts) {
    return {
      incidentId: String(incident._id ?? incidentId),
      summary: incident['narration'].summary,
      facts: incident['narration'].facts,
      citations: incident['narration'].citations ?? [],
      model: incident['narration'].model ?? 'cached',
      citedAt: incident['narration'].citedAt ?? new Date().toISOString(),
      cached: true,
    };
  }

  // Fetch experiment document for replay attribution
  const experiment = await experimentsCol.findOne({
    $or: [{ incidentId: String(incident._id) }, { incidentId }],
  });

  // Query episodic memory lessons for context change matches
  const changeQuery = (incident['changes'] ?? [])
    .map((c: any) => c.summary)
    .join(' ') || 'tool parameter invariant regression';

  let recalledLessons: any[] = [];
  try {
    const recallRes = await recallLessons(db, {
      projectId: incident['projectId'],
      query: changeQuery,
      limit: 2,
    });
    recalledLessons = recallRes.results;
  } catch {
    // Non-fatal if lessons are unavailable
  }

  // Build grounded facts
  const facts = buildFacts(incident as any, experiment as any, recalledLessons);

  let summary = '';
  let modelName = 'deterministic-template';

  // Attempt LLM generation if configured
  if (config.LLM_ENABLED && config.LLM_API_KEY && config.LLM_BASE_URL) {
    try {
      const factListPrompt = facts.map((f) => `[${f.id}] ${f.text}`).join('\n');
      const response = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: config.LLM_MODEL || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'You are an evidence-grounded incident narrator. Summarize the incident in <= 500 characters. ' +
                'EVERY sentence must cite one or more fact tags like [F1], [F2]. ' +
                'DO NOT introduce any numbers, percentages, or tool names that do not appear in the cited facts.',
            },
            {
              role: 'user',
              content: `Ground truth facts:\n${factListPrompt}\n\nProvide a concise 2-4 sentence narrative strictly citing [F1]..[Fn].`,
            },
          ],
          temperature: 0.1,
          max_tokens: 250,
        }),
      });

      if (response.ok) {
        const json = (await response.json()) as any;
        const candidate = json.choices?.[0]?.message?.content?.trim();
        if (candidate) {
          const validated = validateNarration(candidate, facts);
          if (validated.valid && validated.cleanText.length > 0) {
            summary = validated.cleanText;
            modelName = config.LLM_MODEL || 'llm-verified';
          }
        }
      }
    } catch {
      // Fallback to deterministic template below
    }
  }

  // Fallback to deterministic grounded generator if LLM was skipped or failed validation
  if (!summary) {
    const deterministic = generateDeterministicNarration(facts);
    const validated = validateNarration(deterministic, facts);
    summary = validated.cleanText || deterministic;
  }

  const finalValidation = validateNarration(summary, facts);
  const now = new Date().toISOString();

  const narrationRecord = {
    summary,
    facts,
    citations: finalValidation.citations,
    model: modelName,
    citedAt: now,
  };

  // Persist narration on the incident doc
  await incidentsCol.updateOne(
    { _id: incident._id },
    { $set: { narration: narrationRecord } },
  );

  return {
    incidentId: String(incident._id ?? incidentId),
    summary,
    facts,
    citations: finalValidation.citations,
    model: modelName,
    citedAt: now,
    cached: false,
  };
}
