/**
 * server/src/narrate/validate.ts
 *
 * Citation and Hallucination Validator for LLM Narration.
 *
 * Verification rules:
 *   1. Every sentence must cite at least one verified fact tag: [F1], [F2], etc.
 *   2. The cited tag must exist in the provided FactItem set.
 *   3. Any numbers/percentages in a sentence must be grounded in the cited facts
 *      (or correspond to the citation index itself).
 *   4. Sentences that fail verification are dropped.
 *   5. Final narrative summary is strictly truncated to <= 600 characters.
 */

import type { FactItem } from './facts.js';

export interface ValidationResult {
  valid: boolean;
  cleanText: string;
  citations: string[];
  droppedSentences: string[];
}

export function validateNarration(rawText: string, facts: FactItem[]): ValidationResult {
  const factMap = new Map<string, FactItem>();
  for (const f of facts) {
    factMap.set(f.id, f);
  }

  // Split into sentences using punctuation boundaries
  const rawSentences = rawText
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const acceptedSentences: string[] = [];
  const droppedSentences: string[] = [];
  const allCitations = new Set<string>();

  for (const sentence of rawSentences) {
    // 1. Check for citation tags [F1], [F2], etc.
    const citationMatches = sentence.match(/\[F(\d+)\]/g);
    if (!citationMatches || citationMatches.length === 0) {
      droppedSentences.push(`${sentence} (missing citation tag)`);
      continue;
    }

    const citedFactIds = citationMatches.map((m) => m.replace(/[\[\]]/g, ''));
    let allCitationsValid = true;
    const allowedNumbers = new Set<string>();

    for (const cid of citedFactIds) {
      const fact = factMap.get(cid);
      if (!fact) {
        allCitationsValid = false;
        break;
      }
      allCitations.add(cid);
      // Collect all numbers present in cited fact
      for (const num of fact.numbers) {
        allowedNumbers.add(num.replace('%', ''));
        allowedNumbers.add(num);
      }
      // Allow the citation index itself (e.g. "1" for F1)
      const indexNum = cid.replace(/\D/g, '');
      if (indexNum) allowedNumbers.add(indexNum);
    }

    if (!allCitationsValid) {
      droppedSentences.push(`${sentence} (cites non-existent fact tag)`);
      continue;
    }

    // 2. Extract numbers in the sentence and ensure they are grounded
    // Exclude the F-tag numbers like the 1 in [F1]
    const cleanSentenceForNumbers = sentence.replace(/\[F\d+\]/g, '');
    const sentenceNumbers = cleanSentenceForNumbers.match(/\b\d+(?:\.\d+)?%?\b/g) || [];

    let hasUngroundedNumber = false;
    for (const num of sentenceNumbers) {
      const stripped = num.replace('%', '');
      if (!allowedNumbers.has(num) && !allowedNumbers.has(stripped)) {
        hasUngroundedNumber = true;
        break;
      }
    }

    if (hasUngroundedNumber) {
      droppedSentences.push(`${sentence} (contains ungrounded number not in cited facts)`);
      continue;
    }

    acceptedSentences.push(sentence);
  }

  let cleanText = acceptedSentences.join(' ');
  if (cleanText.length > 600) {
    cleanText = cleanText.slice(0, 597) + '…';
  }

  return {
    valid: acceptedSentences.length > 0,
    cleanText,
    citations: Array.from(allCitations).sort(),
    droppedSentences,
  };
}
