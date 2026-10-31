/**
 * scripts/src/eval-lessons.ts
 *
 * Evaluates episodic memory recall against demo/lessons-eval.json.
 * Measures:
 *   - hit@1: rank 1 accuracy on positive queries
 *   - hit@3: top-3 recall on positive queries (target: >= 0.80)
 *   - negative false-positive rate: fraction of unrelated queries matching (target: <= 0.20)
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

export async function runLessonsEval(mongoUri = MONGODB_URI, dbName = MONGODB_DB): Promise<{
  hit1: number;
  hit3: number;
  negativeFpr: number;
  totalPositives: number;
  totalNegatives: number;
}> {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);
  const lessonsCol = db.collection('lessons');

  const projectId = `eval_${Date.now()}`;
  const provider = getEmbeddingProvider();

  // 1. Seed eval lessons into MongoDB
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const seedDocs = [];
  for (const item of evalData.seededLessons) {
    const textToEmbed = `${item.symptom} | ${item.culprit.units.join(', ')} | ${item.changeTypes.join(', ')} | ${item.fix}`;
    let embedding: number[] = [];
    try {
      const v = await provider.embed([textToEmbed], 'document');
      embedding = v[0] ?? [];
    } catch {
      // fallback
    }

    seedDocs.push({
      _id: item.id,
      incidentId: `inc_${item.id}`,
      projectId,
      symptom: item.symptom,
      culprit: item.culprit,
      changeTypes: item.changeTypes,
      fix: item.fix,
      source: 'seed',
      status: 'active',
      embedding,
      createdAt: now,
      expiresAt,
    });
  }

  await lessonsCol.insertMany(seedDocs as any);

  // 2. Evaluate queries
  let hits1 = 0;
  let hits3 = 0;
  let falsePositives = 0;
  let totalPositives = 0;
  let totalNegatives = 0;

  for (const q of evalData.queries) {
    const res = await recallLessons(db, {
      projectId,
      query: q.query,
      minScore: 0.65,
      limit: 3,
    });

    if (q.isNegative) {
      totalNegatives++;
      if (res.results.length > 0) {
        falsePositives++;
      }
    } else {
      totalPositives++;
      const topIds = res.results.map((r) => r.lessonId);
      if (topIds[0] === q.expectedLessonId) {
        hits1++;
      }
      if (topIds.includes(q.expectedLessonId)) {
        hits3++;
      }
    }
  }

  // Cleanup seeded eval lessons
  await lessonsCol.deleteMany({ projectId });
  await client.close();

  const hit1Rate = totalPositives > 0 ? hits1 / totalPositives : 0;
  const hit3Rate = totalPositives > 0 ? hits3 / totalPositives : 0;
  const fpr = totalNegatives > 0 ? falsePositives / totalNegatives : 0;

  return {
    hit1: Math.round(hit1Rate * 100) / 100,
    hit3: Math.round(hit3Rate * 100) / 100,
    negativeFpr: Math.round(fpr * 100) / 100,
    totalPositives,
    totalNegatives,
  };
}

// Standalone execution
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log('\n─── Episodic Memory (Lessons) Eval ───\n');
  runLessonsEval().then((metrics) => {
    console.log(`Positives evaluated: ${metrics.totalPositives}`);
    console.log(`Negatives evaluated: ${metrics.totalNegatives}`);
    console.log(`Hit@1: ${(metrics.hit1 * 100).toFixed(0)}%`);
    console.log(`Hit@3: ${(metrics.hit3 * 100).toFixed(0)}% (threshold: >= 80%)`);
    console.log(`Negative FPR: ${(metrics.negativeFpr * 100).toFixed(0)}% (threshold: <= 20%)`);
    const passed = metrics.hit3 >= 0.8 && metrics.negativeFpr <= 0.2;
    console.log(`\nVerdict: ${passed ? '✅ PASS' : '❌ FAIL'}\n`);
    process.exit(passed ? 0 : 1);
  });
}

