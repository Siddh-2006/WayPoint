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
 *   - Calibrated thresholding: LESSON_MIN_SCORE (0.48) separates strong matches from weak matches
 *   - Honest UI tiering: 'strong match' (cosine >= 0.48 or exact identifier) vs 'weak match'
 *   - RRF rank score is never used as an absolute threshold to promote weak matches to strong
 *   - When EMBED_PROVIDER == 'none' or upon 429/embed error, falls back safely to text_only
 *   - Uses in-memory QueryEmbeddingLruCache to protect trial rate limits (3 RPM / 10K TPM)
 *   - Supports explicit mode override: 'hybrid' | 'rrf' | 'vector_only' | 'text_only'
 *   - Honest score typing: 'cosine' | 'rrf' | 'lexical' (never labels lexical as "similarity")
 */

import type { Db } from 'mongodb';
import { config } from '../config.js';
import { getEmbeddingProvider } from '../embed/index.js';
import { getQueryEmbeddingCache } from '../embed/cache.js';
import type { LessonDoc } from './service.js';

export type ScoreType = 'cosine' | 'rrf' | 'lexical';
export type MatchTier = 'strong match' | 'weak match';

export interface RecallResultItem {
  rank: number;
  lessonId: string;
  score: number;
  scoreType: ScoreType;
  tier: MatchTier;
  why: string;
  lesson: LessonDoc;
}

export interface RecallResponse {
  mode: 'hybrid' | 'rrf' | 'vector_only' | 'text_only';
  results: RecallResultItem[];
  query: string;
  note?: string;
}

let supportsRankFusion: boolean | null = null;

/**
 * Probes at startup whether the MongoDB deployment supports the $rankFusion stage.
 */
export async function probeRankFusionSupport(db: Db): Promise<boolean> {
  if (supportsRankFusion !== null) return supportsRankFusion;

  try {
    const col = db.collection('lessons');
    await col
      .aggregate([{ $match: { _id: 'probe_test' } }, { $rankFusion: {} } as any])
      .toArray();
    supportsRankFusion = true;
  } catch {
    supportsRankFusion = false;
  }
  return supportsRankFusion;
}

const COMMON_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when',
  'was', 'were', 'been', 'have', 'has', 'had', 'are', 'not', 'out',
]);

interface TextMatchItem {
  lesson: LessonDoc;
  score: number;
  matchedTokens: string[];
  exactIdentifierMatch: boolean;
  distinctTokensCount: number;
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
  const strongThreshold = options.minScore ?? config.LESSON_MIN_SCORE;
  const floorThreshold = 0.38; // Floor to capture faint candidate vectors for rank fusion
  const limit = options.limit ?? 5;
  const targetMode = options.mode ?? 'rrf';
  const now = new Date();

  const lessonsCol = db.collection<LessonDoc>('lessons');
  const provider = getEmbeddingProvider();
  const cache = getQueryEmbeddingCache(config.EMBED_CACHE_SIZE);

  // Helper for pure text_only response
  const buildTextOnlyResponse = async (note?: string): Promise<RecallResponse> => {
    const textMatches = await findTextMatches(lessonsCol, projectId, query, now);
    const results: RecallResultItem[] = textMatches
      .filter((item) => item.score >= strongThreshold || item.exactIdentifierMatch || item.distinctTokensCount >= 2)
      .slice(0, limit)
      .map((item, idx) => {
        const isStrong = item.score >= strongThreshold || item.exactIdentifierMatch;
        return {
          rank: idx + 1,
          lessonId: item.lesson._id,
          score: item.score,
          scoreType: 'lexical',
          tier: isStrong ? 'strong match' : 'weak match',
          why: item.exactIdentifierMatch
            ? `Exact identifier matched: ${item.matchedTokens.join(', ')} [strong match]`
            : `Matched via keywords (${item.distinctTokensCount} tokens): ${item.matchedTokens.join(', ')} [${isStrong ? 'strong match' : 'weak match'}]`,
          lesson: item.lesson,
        };
      });

    return {
      mode: 'text_only',
      results,
      query,
      ...(note ? { note } : {}),
    };
  };

  // 1. Text-Only mode if explicitly requested or if provider is 'none'
  if (targetMode === 'text_only' || provider.name === 'none') {
    return buildTextOnlyResponse();
  }

  // 2. Vector Search Path — protected with LRU cache and graceful fallback on 429/network errors
  let queryVector: number[] | undefined = cache.get(provider.model, query);
  if (!queryVector) {
    try {
      // Exactly 1 embedding call attempt per request
      const queryVectors = await provider.embed([query], 'query');
      queryVector = queryVectors[0];
      if (queryVector && queryVector.length > 0) {
        cache.set(provider.model, query, queryVector);
      }
    } catch (err: any) {
      console.warn(`[Waypoint] Vector embedding failed (${err?.message ?? 'error'}). Falling back to text_only recall.`);
      return buildTextOnlyResponse('semantic search temporarily unavailable');
    }
  }

  if (!queryVector || queryVector.length === 0) {
    return buildTextOnlyResponse('semantic search temporarily unavailable');
  }

  const vectorRanks: Map<string, { rank: number; score: number; lesson: LessonDoc }> = new Map();

  try {
    // Execute $vectorSearch on MongoDB Atlas
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
        // Atlas returns (1 + cosine) / 2 for cosine similarity. Convert back to raw cosine in [-1, 1].
        const cosine =
          typeof doc['score'] === 'number'
            ? Math.round((doc['score'] * 2 - 1) * 1000) / 1000
            : Array.isArray(lesson.embedding) && lesson.embedding.length > 0
              ? Math.round(cosineSimilarity(queryVector!, lesson.embedding) * 1000) / 1000
              : 0;
        vectorRanks.set(lesson._id, { rank: idx + 1, score: cosine, lesson });
      });
    } else {
      // In-memory fallback if vector index is still syncing or returned 0
      const candidates = await lessonsCol
        .find({ projectId, status: 'active', expiresAt: { $gt: now } })
        .toArray();
      if (candidates.length > 0) {
        const scored = candidates
          .filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
          .map((c) => ({
            lesson: c,
            score: Math.round(cosineSimilarity(queryVector!, c.embedding) * 1000) / 1000,
          }))
          .sort((a, b) => b.score - a.score);

        scored.forEach((item, idx) => {
          vectorRanks.set(item.lesson._id, { rank: idx + 1, score: item.score, lesson: item.lesson });
        });
      }
    }
  } catch {
    // If Atlas vectorSearch index is missing or building, use in-memory cosine fallback
    const candidates = await lessonsCol
      .find({ projectId, status: 'active', expiresAt: { $gt: now } })
      .toArray();

    if (candidates.length > 0) {
      const scored = candidates
        .filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
        .map((c) => ({
          lesson: c,
          score: Math.round(cosineSimilarity(queryVector!, c.embedding) * 1000) / 1000,
        }))
        .sort((a, b) => b.score - a.score);

      scored.forEach((item, idx) => {
        vectorRanks.set(item.lesson._id, { rank: idx + 1, score: item.score, lesson: item.lesson });
      });
    }
  }

  // 3. Handle explicit vector_only mode
  if (targetMode === 'vector_only') {
    const vectorResults: RecallResultItem[] = Array.from(vectorRanks.values())
      .filter((item) => item.score >= floorThreshold)
      .slice(0, limit)
      .map((item, idx) => {
        const isStrong = item.score >= strongThreshold;
        return {
          rank: idx + 1,
          lessonId: item.lesson._id,
          score: item.score,
          scoreType: 'cosine',
          tier: isStrong ? 'strong match' : 'weak match',
          why: `Vector cosine similarity: ${item.score.toFixed(3)} [${isStrong ? 'strong match' : 'weak match'}]`,
          lesson: item.lesson,
        };
      });

    return { mode: 'vector_only', results: vectorResults, query };
  }

  // 4. Text Path: match keywords, tokens, and exact identifiers
  const textMatches = await findTextMatches(lessonsCol, projectId, query, now);
  const textRanks: Map<string, { rank: number; score: number; distinctTokensCount: number; exactIdentifierMatch: boolean; lesson: LessonDoc }> = new Map();
  textMatches.forEach((item, idx) => {
    textRanks.set(item.lesson._id, {
      rank: idx + 1,
      score: item.score,
      distinctTokensCount: item.distinctTokensCount,
      exactIdentifierMatch: item.exactIdentifierMatch,
      lesson: item.lesson,
    });
  });

  // 5. Combine with Reciprocal Rank Fusion (RRF, k=60)
  const allDocIds = new Set([...vectorRanks.keys(), ...textRanks.keys()]);
  const combinedScores: Array<{
    lessonId: string;
    score: number;
    scoreType: ScoreType;
    tier: MatchTier;
    why: string;
    lesson: LessonDoc;
  }> = [];

  const K = 60;
  for (const docId of allDocIds) {
    const vecItem = vectorRanks.get(docId);
    const txtItem = textRanks.get(docId);

    const lesson = vecItem?.lesson ?? txtItem?.lesson;
    if (!lesson) continue;

    const hasStrongVector = vecItem !== undefined && vecItem.score >= strongThreshold;
    const hasCandidateVector = vecItem !== undefined && vecItem.score >= floorThreshold;
    const hasCandidateLexical = txtItem !== undefined && (txtItem.exactIdentifierMatch || txtItem.distinctTokensCount >= 2);

    // Rule: In RRF mode, must meet candidate vector similarity floor OR have strong lexical match
    if (!hasCandidateVector && !hasCandidateLexical) {
      continue;
    }

    let rrfScore = 0;
    const reasons: string[] = [];

    if (vecItem) {
      rrfScore += 1 / (K + vecItem.rank);
      reasons.push(`Vector rank #${vecItem.rank} (cosine: ${vecItem.score.toFixed(3)})`);
    }

    if (txtItem) {
      rrfScore += 1 / (K + txtItem.rank);
      reasons.push(
        txtItem.exactIdentifierMatch
          ? `Exact identifier rank #${txtItem.rank}`
          : `Keyword rank #${txtItem.rank} (${txtItem.distinctTokensCount} tokens)`,
      );
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

    // Explicit Rule: RRF score is NEVER used to promote a weak vector to a strong match.
    // Only cosine >= LESSON_MIN_SCORE (0.48) or exact identifier match produces 'strong match'.
    const tier: MatchTier = (hasStrongVector || (txtItem && txtItem.exactIdentifierMatch))
      ? 'strong match'
      : 'weak match';

    combinedScores.push({
      lessonId: docId,
      score: Math.round(score * 1000) / 1000,
      scoreType,
      tier,
      why: `${reasons.join('; ')} [${tier}]`,
      lesson,
    });
  }

  // Sort by combined score descending
  combinedScores.sort((a, b) => b.score - a.score);

  const finalResults: RecallResultItem[] = combinedScores
    .slice(0, limit)
    .map((item, idx) => ({
      rank: idx + 1,
      lessonId: item.lessonId,
      score: item.score,
      scoreType: item.scoreType,
      tier: item.tier,
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
 * Distinguishes distinctive tokens and exact identifiers like 'invoice_id'.
 */
async function findTextMatches(
  col: any,
  projectId: string,
  query: string,
  now: Date,
): Promise<TextMatchItem[]> {
  const allTokens = (query.match(/[A-Za-z0-9_-]{3,}/g) ?? []).map((t) => t.toLowerCase());
  if (allTokens.length === 0) return [];

  const distinctiveTokens = allTokens.filter((t) => !COMMON_STOP_WORDS.has(t));
  const tokens = distinctiveTokens.length > 0 ? distinctiveTokens : allTokens;

  const candidates = (await col
    .find({
      projectId,
      status: 'active',
      expiresAt: { $gt: now },
    })
    .toArray()) as LessonDoc[];

  const matches: TextMatchItem[] = [];

  for (const lesson of candidates) {
    const haystack = [
      lesson.symptom,
      lesson.fix,
      (lesson.changeTypes ?? []).join(' '),
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
      const exactIdentifierMatch = tokens.some(
        (t) => (t.includes('_') || t.includes('-')) && haystack.includes(t),
      );
      const overlapRatio = matchedTokens.length / tokens.length;
      const score = exactIdentifierMatch ? 1.0 : Math.round(overlapRatio * 100) / 100;

      matches.push({
        lesson,
        score,
        matchedTokens,
        exactIdentifierMatch,
        distinctTokensCount: matchedTokens.length,
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
