import React from 'react';
import {
  BookOpen,
  Search,
  CheckCircle2,
  AlertTriangle,
  RotateCw,
  Sparkles,
  Calendar,
  Layers,
  ShieldAlert,
} from 'lucide-react';

export interface LessonItem {
  _id: string;
  incidentId: string;
  projectId: string;
  symptom: string;
  culprit: {
    units: string[];
    shapley?: Record<string, number>;
    interaction?: boolean;
  };
  changeTypes: string[];
  fix: string;
  note?: string;
  source: 'incident' | 'seed';
  status: 'active' | 'corrected' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export function LessonsPage() {
  const [lessons, setLessons] = React.useState<LessonItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [queryInput, setQueryInput] = React.useState('');
  const [recallResults, setRecallResults] = React.useState<any[] | null>(null);
  const [recalling, setRecalling] = React.useState(false);
  const [recallMode, setRecallMode] = React.useState<string | null>(null);

  const loadLessons = React.useCallback(async () => {
    try {
      const res = await fetch('/v1/lessons?projectId=demo');
      if (res.ok) {
        const body = (await res.json()) as { lessons: LessonItem[] };
        setLessons(body.lessons || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadLessons();
  }, [loadLessons]);

  async function handleRecallSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!queryInput.trim()) {
      setRecallResults(null);
      return;
    }

    setRecalling(true);
    try {
      const res = await fetch('/v1/lessons/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'demo', query: queryInput }),
      });
      if (res.ok) {
        const data = (await res.json()) as { results: any[]; mode: string };
        setRecallResults(data.results || []);
        setRecallMode(data.mode);
      }
    } catch {
      // ignore
    } finally {
      setRecalling(false);
    }
  }

  async function handleMarkCorrected(lessonId: string) {
    try {
      await fetch(`/v1/lessons/${lessonId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'dev-key-change-me',
        },
        body: JSON.stringify({ status: 'corrected', note: 'Verified fix applied in production' }),
      });
      await loadLessons();
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/80 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100 flex items-center gap-3">
            <BookOpen className="w-6 h-6 text-sky-400" />
            Episodic Memory (Lessons Store)
          </h1>
          <p className="text-sm text-muted mt-1">
            Persisted regression memories and causal invariants prevent recurring silent failures across
            deployments.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-full text-xs font-mono bg-sky-950/60 text-sky-300 border border-sky-800/40">
            {lessons.length} Lessons Indexed
          </span>
        </div>
      </div>

      {/* Semantic / Text Recall Search Bar */}
      <div className="p-6 rounded-2xl bg-card border border-border shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-200 flex items-center gap-2">
            <Search className="w-4 h-4 text-sky-400" />
            Probe Memory Recall (Hybrid Vector + Lexical RRF)
          </h3>
          {recallMode && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
              Mode: {recallMode.toUpperCase()}
            </span>
          )}
        </div>

        <form onSubmit={handleRecallSearch} className="flex gap-3">
          <input
            type="text"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="Type a change description (e.g. 'tool arguments missing invoiceId parameter' or 'invoice_id')..."
            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm text-slate-200 placeholder:text-muted focus:outline-none focus:border-sky-500"
          />
          <button
            type="submit"
            disabled={recalling}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition-all disabled:opacity-50 flex items-center gap-2"
          >
            {recalling ? <RotateCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Recall
          </button>
          {recallResults !== null && (
            <button
              type="button"
              onClick={() => {
                setQueryInput('');
                setRecallResults(null);
              }}
              className="px-3 py-2 rounded-lg text-sm bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
            >
              Clear
            </button>
          )}
        </form>

        {recallResults !== null && (
          <div className="space-y-3 pt-3 border-t border-border">
            <div className="text-xs font-medium text-muted">
              {recallResults.length === 0 ? 'No prior incident matched (safe)' : `Matched ${recallResults.length} relevant lesson(s):`}
            </div>
            {recallResults.map((item, idx) => (
              <div
                key={idx}
                className="p-3.5 rounded-xl bg-slate-900/80 border border-sky-800/40 text-xs space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sky-300 font-mono">{item.lessonId}</span>
                  {item.scoreType === 'lexical' ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-amber-950/70 text-amber-400 border border-amber-800/60">
                      keyword match
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-sky-950 text-sky-400 border border-sky-800">
                      {(item.scoreType === 'cosine' ? 'cosine' : 'rrf')} similarity: {(item.score * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                <p className="text-slate-300">{item.lesson.symptom}</p>
                <p className="text-muted text-[11px] font-mono">Why: {item.why}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Lessons List */}
      <div className="space-y-4">
        <h2 className="text-base font-medium text-slate-200">Active & Corrected Lessons</h2>

        {loading ? (
          <div className="p-8 text-center text-muted text-sm">Loading episodic lessons...</div>
        ) : lessons.length === 0 ? (
          <div className="p-12 text-center rounded-2xl bg-card border border-border space-y-3">
            <BookOpen className="w-10 h-10 text-muted mx-auto" />
            <h3 className="text-base font-medium text-slate-200">No Lessons Recorded Yet</h3>
            <p className="text-xs text-muted max-w-md mx-auto">
              When an incident is investigated and resolved on the Incidents page, Waypoint automatically
              synthesizes an episodic memory lesson here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {lessons.map((lesson) => {
              const isActive = lesson.status === 'active';
              const isCorrected = lesson.status === 'corrected';
              const isSeed = lesson.source === 'seed';

              return (
                <div
                  key={lesson._id}
                  className="p-5 rounded-2xl bg-card border border-border shadow-sm space-y-3.5 hover:border-slate-700 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono text-xs font-bold text-sky-400">{lesson._id}</span>
                      {isSeed && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950/80 text-amber-300 border border-amber-800/60 uppercase tracking-wider">
                          Seeded Example
                        </span>
                      )}
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider ${
                          isActive
                            ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                            : isCorrected
                            ? 'bg-sky-950/80 text-sky-300 border border-sky-800'
                            : 'bg-slate-800 text-slate-400 border border-slate-700'
                        }`}
                      >
                        {lesson.status}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-xs text-muted">
                      <Calendar className="w-3.5 h-3.5" />
                      <span>Expires: {new Date(lesson.expiresAt).toLocaleDateString()}</span>
                    </div>
                  </div>

                  {/* Symptom */}
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Symptom</div>
                    <p className="text-sm text-slate-200 leading-relaxed">{lesson.symptom}</p>
                  </div>

                  {/* Fix & Culprit */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                    <div className="p-3 rounded-xl bg-slate-900/60 border border-border/80 space-y-1">
                      <div className="text-[11px] font-medium text-muted uppercase">Recommended Fix</div>
                      <p className="text-xs text-emerald-300">{lesson.fix}</p>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-900/60 border border-border/80 space-y-1">
                      <div className="text-[11px] font-medium text-muted uppercase">Isolated Culprits</div>
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {lesson.culprit?.units?.map((u) => (
                          <span
                            key={u}
                            className="px-2 py-0.5 rounded text-[11px] font-mono bg-rose-950/60 text-rose-300 border border-rose-800/40"
                          >
                            {u}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Footer actions */}
                  <div className="flex items-center justify-between pt-2 border-t border-border/60 text-xs text-muted">
                    <span className="font-mono text-[11px]">
                      Incident: {lesson.incidentId.slice(0, 16)}
                    </span>

                    {isActive && (
                      <button
                        onClick={() => handleMarkCorrected(lesson._id)}
                        className="px-3 py-1 rounded-md text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
                      >
                        Mark Corrected
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

