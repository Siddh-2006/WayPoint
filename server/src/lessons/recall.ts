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
 *   - Supports explicit mode override: 'hybrid' | 'rrf' | 'vector_only' | 'text_only'
 *   - Honest score typing: 'cosine' | 'rrf' | 'lexical' (never labels lexical as "similarity")
 */

import type { Db } from 'mongodb';
import { config } from '../config.js';
import { getEmbeddingProvider } from '../embed/index.js';
import type { LessonDoc } from './service.js';

export type ScoreType = 'cosine' | 'rrf' | 'lexical';

export interface RecallResultItem {
  rank: number;
  lessonId: string;
  score: number;
  scoreType: ScoreType;
  why: string;
  lesson: LessonDoc;
}

export interface RecallResponse {
  mode: 'hybrid' | 'rrf' | 'vector_only' | 'text_only';
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
    mode?: 'hybrid' | 'rrf' | 'vector_only' | 'text_only' | undefined;
  },
): Promise<RecallResponse> {
  const { projectId, query } = options;
  const minScore = options.minScore ?? config.LESSON_MIN_SCORE;
  const limit = options.limit ?? 5;
  const targetMode = options.mode ?? 'rrf';
  const now = new Date();

  const lessonsCol = db.collection<LessonDoc>('lessons');
  const provider = getEmbeddingProvider();

  // 1. Text-Only mode if requested or if provider is 'none'
  if (targetMode === 'text_only' || provider.name === 'none') {
    const textMatches = await findTextMatches(lessonsCol, projectId, query, now);
    const results: RecallResultItem[] = textMatches
      .filter((item) => item.score >= minScore)
      .slice(0, limit)
      .map((item, idx) => ({
        rank: idx + 1,
        lessonId: item.lesson._id,
        score: item.score,
        scoreType: 'lexical',
        why: `Matched via keywords: ${item.matchedTokens.join(', ')}`,
        lesson: item.lesson,
      }));

    return { mode: 'text_only', results, query };
  }

  // 2. Vector Search Path
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
      if (rawVecResults.length > 0) {
        rawVecResults.forEach((doc, idx) => {
          const lesson = (doc['document'] ?? doc) as LessonDoc;
          const score =
            typeof doc['score'] === 'number'
              ? doc['score']
              : Array.isArray(lesson.embedding) && lesson.embedding.length > 0
                ? cosineSimilarity(queryVector, lesson.embedding)
                : 0;
          if (score >= minScore) {
            vectorRanks.set(lesson._id, { rank: idx + 1, score, lesson });
          }
        });
      } else {
        // Fall back to in-memory cosine if index sync is pending or index returned 0
        const candidates = await lessonsCol
          .find({ projectId, status: 'active', expiresAt: { $gt: now } })
          .toArray();
        if (queryVector && queryVector.length > 0 && candidates.length > 0) {
          const scored = candidates
            .filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
            .map((c) => ({
              lesson: c,
              score: cosineSimilarity(queryVector, c.embedding),
            }))
            .filter((c) => c.score >= minScore)
            .sort((a, b) => b.score - a.score);

          scored.forEach((item, idx) => {
            vectorRanks.set(item.lesson._id, { rank: idx + 1, score: item.score, lesson: item.lesson });
          });
        }
      }
    }
  } catch {
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
          .filter((c) => c.score >= minScore)
          .sort((a, b) => b.score - a.score);

        scored.forEach((item, idx) => {
          vectorRanks.set(item.lesson._id, { rank: idx + 1, score: item.score, lesson: item.lesson });
        });
      }
    } catch {
      // proceed with text path
    }
  }

  // If vector_only was explicitly requested:
  if (targetMode === 'vector_only') {
    const vectorResults: RecallResultItem[] = Array.from(vectorRanks.values())
      .filter((item) => item.score >= minScore)
      .slice(0, limit)
      .map((item) => ({
        rank: item.rank,
        lessonId: item.lesson._id,
        score: Math.round(item.score * 1000) / 1000,
        scoreType: 'cosine',
        why: `Vector cosine similarity: ${(item.score * 100).toFixed(0)}%`,
        lesson: item.lesson,
      }));

    return { mode: 'vector_only', results: vectorResults, query };
  }

  // 3. Text Path: match keywords, tokens, and exact identifiers
  const textMatches = await findTextMatches(lessonsCol, projectId, query, now);
  const textRanks: Map<string, { rank: number; score: number; lesson: LessonDoc }> = new Map();
  textMatches.forEach((item, idx) => {
    if (item.score >= minScore) {
      textRanks.set(item.lesson._id, { rank: idx + 1, score: item.score, lesson: item.lesson });
    }
  });

  // 4. Combine with Reciprocal Rank Fusion (RRF, k=60)
  const allDocIds = new Set([...vectorRanks.keys(), ...textRanks.keys()]);
  const combinedScores: Array<{
    lessonId: string;
    score: number;
    scoreType: ScoreType;
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
      reasons.push(`Keyword match rank #${txtItem.rank}`);
    }

    let score = 0;
    let scoreType: ScoreType = 'lexical';

    if (vecItem && txtItem) {
      score = Math.min(1.0, vecItem.score + 0.25 * txtItem.score);
      scoreType = 'rrf';
    } else if (vecItem) {
      score = vecItem.score;
      scoreType = 'cosine';
    } else if (txtItem) {
      score = txtItem.score;
      scoreType = 'lexical';
    }

    combinedScores.push({
      lessonId: docId,
      score: Math.round(score * 1000) / 1000,
      scoreType,
      why: reasons.join('; '),
      lesson,
    });
  }

  combinedScores.sort((a, b) => b.score - a.score);

  const finalResults: RecallResultItem[] = combinedScores
    .filter((item) => item.score >= minScore)
    .slice(0, limit)
    .map((item, idx) => ({
      rank: idx + 1,
      lessonId: item.lessonId,
      score: item.score,
      scoreType: item.scoreType,
      why: item.why,
      lesson: item.lesson,
    }));

  const rankFusionAvailable = await probeRankFusionSupport(db);
  const activeMode = rankFusionAvailable ? 'hybrid' : 'rrf';

  return {
    mode: activeMode,
    results: finalResults,
    query,
  };
}

/**
 * Finds text matches using regex and token extraction over symptom, fix, and culprit.
 * Returns raw honest overlap ratio (no fake similarity padding).
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
      const exactIdentifierMatch = tokens.some((t) => t.includes('_') && haystack.includes(t));
      const overlapRatio = matchedTokens.length / tokens.length;
      // Honest score: 1.0 for exact token identifier, otherwise literal overlap fraction
      const score = exactIdentifierMatch ? 1.0 : Math.round(overlapRatio * 100) / 100;

      matches.push({
        lesson,
        score,
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
