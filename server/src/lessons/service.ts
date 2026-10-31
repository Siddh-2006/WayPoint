/**
 * server/src/lessons/service.ts
 *
 * Lessons management: resolution of incidents into episodic memory lessons,
 * lifecycle status transitions ('active' | 'corrected' | 'expired'), and deduplication.
 */

import { ObjectId, type Db } from 'mongodb';
import { config } from '../config.js';
import { getEmbeddingProvider } from '../embed/index.js';
import { toObjectIdOrString } from '../replay/engine.js';

export interface CulpritSummary {
  units: string[];
  shapley: Record<string, number>;
  interaction: boolean;
}

export interface LessonDoc {
  _id: string;
  incidentId: string;
  projectId: string;
  symptom: string;
  culprit: CulpritSummary;
  changeTypes: string[];
  fix: string;
  note?: string | undefined;
  source: 'incident' | 'seed';
  status: 'active' | 'corrected' | 'expired';
  embedding: number[];
  embeddingModel?: string | undefined;
  dim?: number | undefined;
  createdAt: Date;
  expiresAt: Date;
}

export interface ResolveIncidentInput {
  fix: string;
  note?: string | undefined;
  source?: 'incident' | 'seed' | undefined;
}

export async function resolveIncident(
  db: Db,
  incidentId: string,
  input: ResolveIncidentInput,
): Promise<LessonDoc> {
  const incidentsCol = db.collection('incidents');
  const experimentsCol = db.collection('experiments');
  const lessonsCol = db.collection<LessonDoc>('lessons');

  const objId = toObjectIdOrString(incidentId);
  const incident = await incidentsCol.findOne({
    $or: [{ _id: objId }, { _id: incidentId as any }, { incidentId }],
  });

  if (!incident) {
    throw new Error(`Incident not found: ${incidentId}`);
  }

  const normalizedIncidentId = String(incident._id ?? incidentId);

  // Check if lesson already exists for this incident (unique incidentId)
  const existing = await lessonsCol.findOne({ incidentId: normalizedIncidentId });
  if (existing) {
    return existing;
  }

  const projectId = incident['projectId'] as string;

  // Retrieve latest done experiment for this incident
  const exp = await experimentsCol.findOne(
    {
      $or: [{ incidentId: normalizedIncidentId }, { incidentId }],
      status: 'done',
    },
    { sort: { createdAt: -1 } },
  );

  // Build plain-English symptom from incident's violationSummary
  const violationSummary = incident['violationSummary'] as Record<string, number> | undefined;
  const symptomParts: string[] = [];

  if (violationSummary && Object.keys(violationSummary).length > 0) {
    for (const [rule, count] of Object.entries(violationSummary)) {
      if (rule.includes('missing') || rule.includes('similar')) {
        symptomParts.push(`Contract violation: required key invoiceId missing; found similar key invoice_id in tool arguments (${count} occurrences).`);
      } else {
        symptomParts.push(`${count} instances of rule violation "${rule}".`);
      }
    }
  } else {
    symptomParts.push(`Contract violations detected with elevated failure rate ${(incident['rate'] * 100).toFixed(0)}%.`);
  }

  const symptom = symptomParts.join(' ');

  const culpritsList = (exp?.['culprits'] as string[] | undefined) ?? [];
  const shapleyScores = (exp?.['shapley'] as Record<string, number> | undefined) ?? {};
  const isInteraction = Boolean(exp?.['interactionEffect']);
  const changeTypes = (exp?.['units'] as string[] | undefined) ?? ['model', 'prompt'];

  const culprit: CulpritSummary = {
    units: culpritsList,
    shapley: shapleyScores,
    interaction: isInteraction,
  };

  const textToEmbed = `${symptom} | ${culpritsList.join(', ')} | ${changeTypes.join(', ')} | ${input.fix}`;

  // Generate vector embedding
  const provider = getEmbeddingProvider();
  let embedding: number[] = [];
  try {
    const vectors = await provider.embed([textToEmbed], 'document');
    embedding = vectors[0] ?? [];
  } catch (err) {
    console.warn('[Lessons] Failed to generate embedding; storing empty vector:', err);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.LESSON_TTL_DAYS * 24 * 60 * 60 * 1000);
  const lessonId = `les_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const lessonDoc: LessonDoc = {
    _id: lessonId,
    incidentId: normalizedIncidentId,
    projectId,
    symptom,
    culprit,
    changeTypes,
    fix: input.fix,
    note: input.note,
    source: input.source ?? 'incident',
    status: 'active',
    embedding,
    embeddingModel: provider.model,
    dim: provider.dim,
    createdAt: now,
    expiresAt,
  };

  try {
    await lessonsCol.insertOne(lessonDoc as any);
  } catch (err: any) {
    // If concurrent insert created it, return the existing one
    if (err?.code === 11000) {
      const alreadyCreated = await lessonsCol.findOne({ incidentId: normalizedIncidentId });
      if (alreadyCreated) return alreadyCreated;
    }
    throw err;
  }

  // Update incident status to resolved
  await incidentsCol.updateOne(
    { _id: incident._id },
    { $set: { status: 'resolved', resolvedAt: now, lessonId } },
  );

  return lessonDoc;
}

export async function patchLesson(
  db: Db,
  lessonId: string,
  patch: { status?: 'active' | 'corrected' | 'expired' | undefined; note?: string | undefined },
): Promise<LessonDoc | null> {
  const lessonsCol = db.collection<LessonDoc>('lessons');
  const update: Record<string, unknown> = {};
  if (patch.status) update['status'] = patch.status;
  if (patch.note !== undefined) update['note'] = patch.note;

  await lessonsCol.updateOne(
    { _id: lessonId },
    { $set: update },
  );

  return lessonsCol.findOne({ _id: lessonId });
}

export async function listLessons(db: Db, projectId: string): Promise<LessonDoc[]> {
  const lessonsCol = db.collection<LessonDoc>('lessons');
  return lessonsCol
    .find({ projectId })
    .sort({ createdAt: -1 })
    .toArray();
}

/**
 * Re-embeds all existing lessons if their embedding is missing or has the wrong dimension.
 * Records embeddingModel and dim on each lesson doc.
 */
export async function syncLessonEmbeddings(db: Db): Promise<{ synced: number }> {
  const provider = getEmbeddingProvider();
  if (provider.name === 'none') return { synced: 0 };

  const lessonsCol = db.collection<LessonDoc>('lessons');
  const lessons = await lessonsCol.find({}).toArray();

  let synced = 0;
  for (const lesson of lessons) {
    const needsEmbed =
      !Array.isArray(lesson.embedding) ||
      lesson.embedding.length !== provider.dim ||
      lesson.embedding.length === 0;

    if (needsEmbed) {
      const culpritsList = Array.isArray(lesson.culprit?.units) ? lesson.culprit.units : [];
      const changeTypesList = Array.isArray(lesson.changeTypes) ? lesson.changeTypes : [];
      const textToEmbed = `${lesson.symptom || ''} | ${culpritsList.join(', ')} | ${changeTypesList.join(', ')} | ${lesson.fix || ''}`;
      try {
        const [vec] = await provider.embed([textToEmbed], 'document');
        if (vec && vec.length === provider.dim) {
          await lessonsCol.updateOne(
            { _id: lesson._id },
            {
              $set: {
                embedding: vec,
                embeddingModel: provider.model,
                dim: provider.dim,
              },
            },
          );
          synced++;
        }
      } catch (err) {
        console.warn(`[Lessons] Failed to re-embed lesson ${lesson._id}:`, err);
      }
    }
  }

  if (synced > 0) {
    console.log(`[Lessons] Re-embedded ${synced} lessons with model "${provider.model}" (dim ${provider.dim})`);
  }
  return { synced };
}

