/**
 * server/src/lessons/recall.ts
 *
 * Hybrid vector + text episodic memory recall with Reciprocal Rank Fusion (RRF).
 *
 * Requirements:
 *   - $vectorSearch filtered by projectId and status == 'active'
 *   - Hard filter expiresAt > now in pipeline (TTL cleanup has up to ~60s lag)
 *   - Reciprocal Rank Fusion (k=60) combining vector cosine distance + text matching
 *   - Exact token matching for identifiers like "invoice_id"
 *   - Filters out results below LESSON_MIN_SCORE
 *   - When EMBED_PROVIDER == 'none', falls back to text_only recall mode
 */

import type { Db } from 'mongodb';
import { config } from '../config.js';
import { getEmbeddingProvider } from '../embed/index.js';
import type { LessonDoc } from './service.js';

export interface RecallResultItem {
  lessonId: string;
  score: number;
  why: string;
  lesson: LessonDoc;
}

export interface RecallResponse {
  mode: 'hybrid' | 'rrf' | 'text_only';
  results: RecallResultItem[];
  query: string;
}

let supportsRankFusion: boolean | null = null;

/**
 * Probes at startup whether the MongoDB deployment supports the $rankFusion stage.
 */
export async function probeRankFusionSupport(db: Db): Promise<boolean> {
  if (supportsRankFusion !== null) return supportsRankFusion;

  try {
    const col = db.collection('lessons');
    // Attempt an aggregation with $rankFusion
    await col
      .aggregate([{ $match: { _id: 'probe_test' } }, { $rankFusion: {} } as any])
      .toArray();
    supportsRankFusion = true;
  } catch {
    supportsRankFusion = false;
  }
  return supportsRankFusion;
}

export async function recallLessons(
  db: Db,
  options: {
    projectId: string;
    query: string;
    minScore?: number | undefined;
    limit?: number | undefined;
  },
): Promise<RecallResponse> {
  const { projectId, query } = options;
  const minScore = options.minScore ?? config.LESSON_MIN_SCORE;
  const limit = options.limit ?? 5;
  const now = new Date();

  const lessonsCol = db.collection<LessonDoc>('lessons');
  const provider = getEmbeddingProvider();

  // 1. Text-Only mode if provider is 'none'
  if (provider.name === 'none') {
    const textMatches = await findTextMatches(lessonsCol, projectId, query, now);
    const results: RecallResultItem[] = textMatches
      .map((item) => ({
        lessonId: item.lesson._id,
        score: item.score,
        why: `Matched via text search tokens: ${item.matchedTokens.join(', ')}`,
        lesson: item.lesson,
      }))
      .filter((r) => r.score >= minScore)
      .slice(0, limit);

    return { mode: 'text_only', results, query };
  }

  // 2. Vector Search + Text Search with Reciprocal Rank Fusion (k=60)
  let vectorRanks: Map<string, { rank: number; score: number; lesson: LessonDoc }> = new Map();

  try {
    const queryVectors = await provider.embed([query], 'query');
    const queryVector = queryVectors[0];

    if (queryVector && queryVector.length > 0) {
      // Execute $vectorSearch
      const vectorPipeline = [
        {
          $vectorSearch: {
            index: 'lessons_vector',
            path: 'embedding',
            queryVector,
            numCandidates: 50,
            limit: 20,
            filter: {
              $and: [
                { projectId: { $eq: projectId } },
                { status: { $eq: 'active' } },
              ],
            },
          },
        },
        // Hard filter: expiresAt > now (do not rely on TTL monitor lag)
        {
          $match: {
            expiresAt: { $gt: now },
            status: 'active',
            projectId,
          },
        },
        {
          $project: {
            score: { $meta: 'vectorSearchScore' },
            document: '$$ROOT',
          },
        },
      ];

      const rawVecResults = await lessonsCol.aggregate(vectorPipeline).toArray();
      rawVecResults.forEach((doc, idx) => {
        const lesson = (doc['document'] ?? doc) as LessonDoc;
        const score = typeof doc['score'] === 'number' ? doc['score'] : 0.8;
        vectorRanks.set(lesson._id, { rank: idx + 1, score, lesson });
      });
    }
  } catch (err) {
    // If Atlas vector search index is not yet built or unavailable, fall back to in-memory cosine
    const candidates = await lessonsCol
      .find({ projectId, status: 'active', expiresAt: { $gt: now } })
      .toArray();

    try {
      const queryVectors = await provider.embed([query], 'query');
      const qVec = queryVectors[0];
      if (qVec && qVec.length > 0) {
        const scored = candidates
          .filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
          .map((c) => ({
            lesson: c,
            score: cosineSimilarity(qVec, c.embedding),
          }))
          .sort((a, b) => b.score - a.score);

        scored.forEach((item, idx) => {
          vectorRanks.set(item.lesson._id, { rank: idx + 1, score: item.score, lesson: item.lesson });
        });
      }
    } catch {
      // proceed with text path
    }
  }

  // 3. Text Path: match keywords, tokens, and exact identifiers
  const textMatches = await findTextMatches(lessonsCol, projectId, query, now);
  const textRanks: Map<string, { rank: number; score: number; lesson: LessonDoc }> = new Map();
  textMatches.forEach((item, idx) => {
    textRanks.set(item.lesson._id, { rank: idx + 1, score: item.score, lesson: item.lesson });
  });

  // 4. Combine with Reciprocal Rank Fusion (RRF, k=60)
  const allDocIds = new Set([...vectorRanks.keys(), ...textRanks.keys()]);
  const combinedScores: Array<{
    lessonId: string;
    rrfScore: number;
    normalizedScore: number;
    why: string;
    lesson: LessonDoc;
  }> = [];

  const K = 60;
  for (const docId of allDocIds) {
    const vecItem = vectorRanks.get(docId);
    const txtItem = textRanks.get(docId);

    const lesson = vecItem?.lesson ?? txtItem?.lesson;
    if (!lesson) continue;

    let rrfScore = 0;
    const reasons: string[] = [];

    if (vecItem) {
      rrfScore += 1 / (K + vecItem.rank);
      reasons.push(`Vector match rank #${vecItem.rank} (sim: ${(vecItem.score * 100).toFixed(0)}%)`);
    }

    if (txtItem) {
      rrfScore += 1 / (K + txtItem.rank);
      reasons.push(`Text match rank #${txtItem.rank}`);
    }

    // Max theoretical RRF score with 2 sources is 2 / (K + 1) = 2/61 = ~0.03278
    // Normalize to [0, 1] range:
    const normalizedScore = vecItem
      ? Math.max(vecItem.score, Math.min(1.0, (rrfScore / (2 / (K + 1))) * 0.95))
      : Math.min(1.0, (rrfScore / (1 / (K + 1))) * 0.85);

    combinedScores.push({
      lessonId: docId,
      rrfScore,
      normalizedScore: Math.round(normalizedScore * 1000) / 1000,
      why: reasons.join('; '),
      lesson,
    });
  }

  combinedScores.sort((a, b) => b.normalizedScore - a.normalizedScore);

  const finalResults: RecallResultItem[] = combinedScores
    .filter((item) => item.normalizedScore >= minScore)
    .slice(0, limit)
    .map((item) => ({
      lessonId: item.lessonId,
      score: item.normalizedScore,
      why: item.why,
      lesson: item.lesson,
    }));

  return {
    mode: 'rrf',
    results: finalResults,
    query,
  };
}

/**
 * Finds text matches using regex and token extraction over symptom, fix, and culprit.
 */
async function findTextMatches(
  col: any,
  projectId: string,
  query: string,
  now: Date,
): Promise<Array<{ lesson: LessonDoc; score: number; matchedTokens: string[] }>> {
  // Extract tokens >= 3 chars, plus snake_case identifiers like 'invoice_id'
  const tokens = (query.match(/[A-Za-z0-9_]{3,}/g) ?? []).map((t) => t.toLowerCase());
  if (tokens.length === 0) return [];

  // Scoped strictly to active, non-expired lessons for this project
  const candidates = (await col
    .find({
      projectId,
      status: 'active',
      expiresAt: { $gt: now },
    })
    .toArray()) as LessonDoc[];

  const matches: Array<{ lesson: LessonDoc; score: number; matchedTokens: string[] }> = [];

  for (const lesson of candidates) {
    const haystack = [
      lesson.symptom,
      lesson.fix,
      lesson.changeTypes.join(' '),
      lesson.culprit?.units?.join(' ') ?? '',
    ]
      .join(' ')
      .toLowerCase();

    const matchedTokens: string[] = [];
    for (const token of tokens) {
      if (haystack.includes(token)) {
        matchedTokens.push(token);
      }
    }

    if (matchedTokens.length > 0) {
      // Score based on token overlap proportion
      const exactIdentifierMatch = tokens.some((t) => t.includes('_') && haystack.includes(t));
      const overlapRatio = matchedTokens.length / tokens.length;
      let score = 0.5 + overlapRatio * 0.45;
      if (exactIdentifierMatch) score = Math.max(score, 0.88);

      matches.push({
        lesson,
        score: Math.min(1.0, Math.round(score * 100) / 100),
        matchedTokens,
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
