/**
 * scripts/src/eval-lessons.ts
 *
 * Evaluates episodic memory recall against demo/lessons-eval.json.
 * Measures hit@1, hit@3, and negative false-positive rate across three modes:
 *   - text_only: keyword / token overlap
 *   - vector_only: cosine similarity over vector embeddings
 *   - rrf: hybrid reciprocal rank fusion (k=60)
 *
 * Proves that semantic vectors dramatically outperform text-only on hard paraphrases.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { loadEnv, requireEnv } from './env.js';
import { recallLessons } from '../../server/src/lessons/recall.js';
import { getEmbeddingProvider } from '../../server/src/embed/index.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_PATH = resolve(__dirname, '../../demo/lessons-eval.json');
const evalData = JSON.parse(readFileSync(EVAL_PATH, 'utf-8'));

const MONGODB_URI = requireEnv('MONGODB_URI');
const MONGODB_DB = requireEnv('MONGODB_DB');

export interface ModeMetrics {
  mode: 'text_only' | 'vector_only' | 'rrf';
  hit1: number;
  hit3: number;
  negativeFpr: number;
  hardParaphraseHit1: number;
  hardParaphraseHit3: number;
  totalPositives: number;
  totalNegatives: number;
}

export async function runLessonsEval(
  mongoUri = MONGODB_URI,
  dbName = MONGODB_DB,
  minScore = 0.25,
): Promise<{
  modes: Record<'text_only' | 'vector_only' | 'rrf', ModeMetrics>;
  hardParaphraseCompare: { query: string; expected: string; textRank: number | null; rrfRank: number | null };
}> {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);
  const lessonsCol = db.collection('lessons');

  const projectId = `eval_${Date.now()}`;
  const provider = getEmbeddingProvider();

  // 1. Seed eval lessons with real embeddings in a single batch request
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const textsToEmbed = evalData.seededLessons.map((item: any) => {
    const culpritsList = item.culprit?.units ?? [];
    return `${item.symptom} | ${culpritsList.join(', ')} | ${item.changeTypes.join(', ')} | ${item.fix}`;
  });

  console.log('[Voyage Eval] Embedding 8 seeded lessons in 1 batch...');
  const embeddings = await provider.embed(textsToEmbed, 'document');

  const seedDocs = evalData.seededLessons.map((item: any, idx: number) => ({
    _id: item.id,
    incidentId: `inc_${item.id}`,
    projectId,
    symptom: item.symptom,
    culprit: item.culprit,
    changeTypes: item.changeTypes,
    fix: item.fix,
    source: 'seed',
    status: 'active',
    embedding: embeddings[idx] ?? [],
    embeddingModel: provider.model,
    dim: provider.dim,
    createdAt: now,
    expiresAt,
  }));

  await lessonsCol.insertMany(seedDocs as any);

  console.log(`[Voyage Eval] Embedded & inserted 8 lessons. Pacing 25s for Atlas trial rate limit...`);
  await new Promise((r) => setTimeout(r, 25_000));

  // Pre-embed all unique query strings in a single batch request to stay within Atlas Voyage 3 RPM trial limit
  const { queryEmbeddingCache } = await import('../../server/src/lessons/recall.js');
  const uniqueQueries = Array.from(new Set(evalData.queries.map((q: any) => q.query))) as string[];
  console.log(`[Voyage Eval] Embedding ${uniqueQueries.length} unique queries in 1 batch...`);
  const queryVectors = await provider.embed(uniqueQueries, 'query');
  console.log(`[Voyage Eval] Successfully pre-embedded ${uniqueQueries.length} queries.`);
  uniqueQueries.forEach((q, idx) => {
    if (queryVectors[idx]) {
      queryEmbeddingCache.set(q, queryVectors[idx]);
    }
  });

  // 2. Helper to run evaluation for a given mode
  async function evaluateMode(mode: 'text_only' | 'vector_only' | 'rrf'): Promise<ModeMetrics> {
    let hits1 = 0;
    let hits3 = 0;
    let falsePositives = 0;
    let totalPositives = 0;
    let totalNegatives = 0;

    let hardHits1 = 0;
    let hardHits3 = 0;
    let totalHard = 0;

    for (const q of evalData.queries) {
      const res = await recallLessons(db, {
        projectId,
        query: q.query,
        minScore,
        limit: 3,
        mode,
      });

      if (q.isNegative) {
        totalNegatives++;
        if (res.results.length > 0) {
          falsePositives++;
        }
      } else {
        totalPositives++;
        const isHard = q.kind === 'hard_paraphrase';
        if (isHard) totalHard++;

        const topIds = res.results.map((r) => r.lessonId);
        if (topIds[0] === q.expectedLessonId) {
          hits1++;
          if (isHard) hardHits1++;
        }
        if (topIds.includes(q.expectedLessonId)) {
          hits3++;
          if (isHard) hardHits3++;
        }
      }
    }

    return {
      mode,
      hit1: totalPositives > 0 ? Math.round((hits1 / totalPositives) * 100) / 100 : 0,
      hit3: totalPositives > 0 ? Math.round((hits3 / totalPositives) * 100) / 100 : 0,
      negativeFpr: totalNegatives > 0 ? Math.round((falsePositives / totalNegatives) * 100) / 100 : 0,
      hardParaphraseHit1: totalHard > 0 ? Math.round((hardHits1 / totalHard) * 100) / 100 : 0,
      hardParaphraseHit3: totalHard > 0 ? Math.round((hardHits3 / totalHard) * 100) / 100 : 0,
      totalPositives,
      totalNegatives,
    };
  }

  const textMetrics = await evaluateMode('text_only');
  const vectorMetrics = await evaluateMode('vector_only');
  const rrfMetrics = await evaluateMode('rrf');

  const hardQueries = [
    {
      q: 'underlying foundation architecture shifted property casing conventions to underscores',
      target: 'lesson-seed-1',
    },
    {
      q: 'the new model renamed a field to snake case',
      target: 'lesson-seed-1',
    },
    {
      q: 'floating point value serialized as text instead of numeric',
      target: 'lesson-seed-3',
    },
  ];

  const hardParaphraseRanks = [];
  for (const hq of hardQueries) {
    const tRes = await recallLessons(db, { projectId, query: hq.q, mode: 'text_only', minScore: 0.25, limit: 5 });
    const vRes = await recallLessons(db, { projectId, query: hq.q, mode: 'vector_only', minScore: 0.25, limit: 5 });
    const rRes = await recallLessons(db, { projectId, query: hq.q, mode: 'rrf', minScore: 0.25, limit: 5 });

    const tRank = tRes.results.findIndex((r) => r.lessonId === hq.target) + 1;
    const vRank = vRes.results.findIndex((r) => r.lessonId === hq.target) + 1;
    const rRank = rRes.results.findIndex((r) => r.lessonId === hq.target) + 1;

    hardParaphraseRanks.push({
      q: hq.q,
      target: hq.target,
      textRank: tRank > 0 ? tRank : null,
      vectorRank: vRank > 0 ? vRank : null,
      rrfRank: rRank > 0 ? rRank : null,
    });
  }

  // Hard paraphrase comparison sample (shares 0 content words with lesson-seed-1)
  const sampleQuery = 'underlying foundation architecture shifted property casing conventions to underscores';
  const expectedTarget = 'lesson-seed-1';

  const textRes = await recallLessons(db, { projectId, query: sampleQuery, mode: 'text_only', minScore, limit: 5 });
  const rrfRes = await recallLessons(db, { projectId, query: sampleQuery, mode: 'rrf', minScore, limit: 5 });

  const textIdx = textRes.results.findIndex((r) => r.lessonId === expectedTarget);
  const rrfIdx = rrfRes.results.findIndex((r) => r.lessonId === expectedTarget);

  const hardParaphraseCompare = {
    query: sampleQuery,
    expected: expectedTarget,
    textRank: textIdx >= 0 ? textIdx + 1 : null,
    rrfRank: rrfIdx >= 0 ? rrfIdx + 1 : null,
  };

  // Cleanup seeded eval lessons
  await lessonsCol.deleteMany({ projectId });
  await client.close();

  return {
    modes: {
      text_only: textMetrics,
      vector_only: vectorMetrics,
      rrf: rrfMetrics,
    },
    hardParaphraseCompare,
    hardParaphraseRanks,
  };
}

// Standalone execution
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log('\n─── Episodic Memory 3-Mode Benchmark (Text vs Vector vs RRF) ───\n');
  runLessonsEval().then(({ modes, hardParaphraseCompare }) => {
    console.log('Mode         | Hit@1 | Hit@3 | Neg FPR | Hard Hit@3');
    console.log('-------------|-------|-------|---------|-----------');
    for (const m of ['text_only', 'vector_only', 'rrf'] as const) {
      const d = modes[m];
      const mStr = m.padEnd(12);
      const h1Str = `${(d.hit1 * 100).toFixed(0)}%`.padEnd(5);
      const h3Str = `${(d.hit3 * 100).toFixed(0)}%`.padEnd(5);
      const fprStr = `${(d.negativeFpr * 100).toFixed(0)}%`.padEnd(7);
      const hardStr = `${(d.hardParaphraseHit3 * 100).toFixed(0)}%`;
      console.log(`${mStr} | ${h1Str} | ${h3Str} | ${fprStr} | ${hardStr}`);
    }

    console.log('\nHard paraphrase test query:');
    console.log(`"${hardParaphraseCompare.query}" (target: ${hardParaphraseCompare.expected})`);
    console.log(`  - text_only rank: ${hardParaphraseCompare.textRank ?? 'NOT FOUND (unmatched)'}`);
    console.log(`  - rrf rank:       #${hardParaphraseCompare.rrfRank ?? 'NOT FOUND'}`);

    const rrfPassed = modes.rrf.hit3 >= 0.8 && modes.rrf.negativeFpr <= 0.2;
    console.log(`\nEval Result: ${rrfPassed ? '✅ PASS' : '❌ FAIL'}\n`);
    process.exit(rrfPassed ? 0 : 1);
  });
}
