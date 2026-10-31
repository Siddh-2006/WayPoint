import React from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  RotateCw,
  Play,
  FileCode,
  Layers,
  Sparkles,
  Info,
} from 'lucide-react';

export function PreflightPage() {
  const [selectedScenario, setSelectedScenario] = React.useState<string>('bad_deploy');
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<any | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  async function handleRunPreflight() {
    setRunning(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/v1/demo/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId: selectedScenario, projectId: 'demo' }),
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string; message?: string };
        throw new Error(err.message || err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setResult(data);
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/80 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100 flex items-center gap-3">
            <ShieldCheck className="w-6 h-6 text-sky-400" />
            Preflight Gate & Regression Guard
          </h1>
          <p className="text-sm text-muted mt-1">
            Simulates proposed deployment contexts against live baseline contracts and checks episodic memory
            lessons before commit.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleRunPreflight}
            disabled={running}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition-all disabled:opacity-50"
          >
            {running ? <RotateCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
            Run Preflight Check
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl border border-rose-500/40 bg-rose-950/30 text-rose-300 text-sm flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Scenario Picker */}
      <div className="p-6 rounded-2xl bg-card border border-border shadow-sm space-y-4">
        <h3 className="text-sm font-medium text-slate-200">Select Proposed Candidate Deployment</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { id: 'bad_deploy', label: 'Bad Deploy (v2 + Old Prompt)', desc: 'Planted 2-way regression' },
            { id: 'good', label: 'Clean Baseline (v1 + CamelCase)', desc: 'Known-good production context' },
            { id: 'model_only', label: 'Model v2 Only', desc: 'Upgraded model with safe prompt' },
            { id: 'prompt_only', label: 'Old Prompt Only', desc: 'Old prompt on model v1' },
          ].map((sc) => (
            <button
              key={sc.id}
              onClick={() => setSelectedScenario(sc.id)}
              className={`p-3.5 rounded-xl border text-left transition-all ${
                selectedScenario === sc.id
                  ? 'bg-sky-950/40 border-sky-500 text-sky-200 shadow-sm'
                  : 'bg-slate-900/50 border-border hover:border-slate-700 text-slate-300'
              }`}
            >
              <div className="font-semibold text-xs">{sc.label}</div>
              <div className="text-[11px] text-muted mt-1">{sc.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Results View */}
      {result && (
        <div className="space-y-6">
          {/* Verdict Banner */}
          <div
            className={`p-6 rounded-2xl border flex flex-col md:flex-row md:items-center justify-between gap-4 ${
              result.verdict === 'block'
                ? 'bg-rose-950/30 border-rose-600/60 text-rose-200'
                : result.verdict === 'warn'
                ? 'bg-amber-950/30 border-amber-600/60 text-amber-200'
                : 'bg-emerald-950/30 border-emerald-600/60 text-emerald-200'
            }`}
          >
            <div className="flex items-start gap-4">
              {result.verdict === 'block' ? (
                <ShieldAlert className="w-8 h-8 text-rose-400 shrink-0 mt-0.5" />
              ) : result.verdict === 'warn' ? (
                <AlertTriangle className="w-8 h-8 text-amber-400 shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="w-8 h-8 text-emerald-400 shrink-0 mt-0.5" />
              )}
              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  <span className="text-xl font-bold uppercase tracking-wider">
                    VERDICT: {result.verdict}
                  </span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-700">
                    Recall: {result.recallMode.toUpperCase()}
                  </span>
                </div>
                <ul className="text-xs space-y-1 pt-1 list-disc list-inside opacity-90">
                  {result.reasons?.map((r: string, idx: number) => (
                    <li key={idx}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="text-right font-mono text-xs">
              <div>Simulation Violation Rate:</div>
              <div className="text-lg font-bold">
                {(result.replay?.violationRate * 100).toFixed(0)}%
              </div>
              <div className="text-[11px] opacity-75">
                95% CI: [{(result.replay?.wilson?.lower * 100).toFixed(0)}%,{' '}
                {(result.replay?.wilson?.upper * 100).toFixed(0)}%]
              </div>
            </div>
          </div>

          {/* Plain Compact Summary Box (<= 600 chars) */}
          <div className="p-5 rounded-2xl bg-card border border-border shadow-sm space-y-2">
            <div className="flex items-center justify-between text-xs font-medium text-muted uppercase tracking-wider">
              <span>Compact Preflight Summary (LLM Ready)</span>
              <span>{result.summary.length} / 600 chars</span>
            </div>
            <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-700/80 font-mono text-xs text-sky-300 leading-relaxed">
              {result.summary}
            </div>
          </div>

          {/* Matched Regression Lessons */}
          <div className="p-6 rounded-2xl bg-card border border-border shadow-sm space-y-4">
            <h3 className="text-base font-medium text-slate-200 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-sky-400" />
              Relevant Historical Lessons Recalled ({result.matchedLessons?.length ?? 0})
            </h3>

            {result.matchedLessons?.length === 0 ? (
              <p className="text-xs text-muted">No historical regressions matched this change set.</p>
            ) : (
              <div className="space-y-3">
                {result.matchedLessons?.map((item: any) => (
                  <div
                    key={item.lessonId}
                    className="p-4 rounded-xl bg-slate-900/70 border border-border space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-semibold text-sky-300">
                        {item.lessonId}
                      </span>
                      {item.scoreType === 'lexical' ? (
                        <span className="text-xs font-mono px-2 py-0.5 rounded bg-amber-950/70 text-amber-400 border border-amber-800/60">
                          keyword match
                        </span>
                      ) : (
                        <span className="text-xs font-mono px-2 py-0.5 rounded bg-sky-950 text-sky-400 border border-sky-800">
                          similarity: {(item.score * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-200">{item.lesson?.symptom}</p>
                    <div className="p-2.5 rounded-lg bg-slate-950 border border-border/60 text-xs text-emerald-300">
                      <strong>Fix:</strong> {item.lesson?.fix}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

