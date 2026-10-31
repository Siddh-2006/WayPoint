import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ErrorBar,
} from 'recharts';
import {
  Cpu,
  Layers,
  CheckCircle2,
  AlertTriangle,
  Play,
  RotateCw,
  GitBranch,
  ShieldCheck,
  Zap,
  Info,
  HelpCircle,
} from 'lucide-react';

export interface WilsonInterval {
  lower: number;
  upper: number;
  estimate: number;
}

export interface ReplayCellStats {
  mask: string;
  activeUnits: string[];
  evaluations: number;
  violationsCount: number;
  violationRate: number;
  wilson: WilsonInterval;
  verdict: 'failing' | 'ok' | 'inconclusive';
}

export interface PairwiseInteraction {
  pair: [string, string];
  interaction: number;
}

export interface ExperimentData {
  _id: string;
  incidentId: string;
  projectId: string;
  baselineHash: string;
  badHash: string;
  units: string[];
  grid: ReplayCellStats[];
  shapley: Record<string, number>;
  shapleyIntervals?: Record<string, { lower: number; upper: number }>;
  pairwiseInteractions?: PairwiseInteraction[];
  totalShift: number;
  culprits: string[];
  interactionEffect: boolean;
  method: 'exact' | 'sampled';
  methodNote?: string;
  caveat: string;
  recommendation: string;
  agentCallsCount: number;
  cacheHitsCount: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  reason?: string;
  createdAt: string;
}

export function ExperimentsPage() {
  const [experiments, setExperiments] = React.useState<ExperimentData[]>([]);
  const [selectedExp, setSelectedExp] = React.useState<ExperimentData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [incidentIdInput, setIncidentIdInput] = React.useState('');
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  // Load experiments for demo project
  const loadExperiments = React.useCallback(async () => {
    try {
      const res = await fetch('/v1/experiments?projectId=demo');
      if (res.ok) {
        const data = (await res.json()) as { experiments: ExperimentData[] };
        setExperiments(data.experiments || []);
        if (data.experiments.length > 0 && !selectedExp) {
          setSelectedExp(data.experiments[0]!);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [selectedExp]);

  React.useEffect(() => {
    loadExperiments();
  }, [loadExperiments]);

  // Polling when an experiment is queued or running
  React.useEffect(() => {
    if (!selectedExp || (selectedExp.status !== 'queued' && selectedExp.status !== 'running')) {
      return;
    }

    const pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/v1/experiments/${selectedExp._id}`);
        if (res.ok) {
          const body = (await res.json()) as { experiment: ExperimentData };
          setSelectedExp(body.experiment);
          if (body.experiment.status === 'done' || body.experiment.status === 'failed') {
            await loadExperiments();
          }
        }
      } catch {
        // ignore
      }
    }, 1500);

    return () => clearInterval(pollTimer);
  }, [selectedExp, loadExperiments]);

  // Run replay on an incident
  async function handleRunReplay(targetIncidentId?: string) {
    let id = targetIncidentId || incidentIdInput;
    if (!id) {
      try {
        const incRes = await fetch('/v1/incidents?projectId=demo');
        if (incRes.ok) {
          const incData = (await incRes.json()) as { incidents?: Array<{ _id: string; id?: string }> };
          const first = incData.incidents?.[0];
          if (first) {
            id = first._id ?? first.id!;
          }
        }
      } catch {
        // fallback
      }
    }

    if (!id) {
      setErrorMsg('Please trigger Bad Deploy first to open an incident.');
      return;
    }

    setRunning(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/v1/incidents/${id}/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        const err = (await res.json()) as { message?: string; error?: string };
        throw new Error(err.message || err.error || `HTTP ${res.status}`);
      }

      const body = (await res.json()) as { experimentId: string; experiment?: ExperimentData };
      if (body.experiment) {
        setSelectedExp(body.experiment);
      } else {
        // Fetch queued experiment
        const expRes = await fetch(`/v1/experiments/${body.experimentId}`);
        if (expRes.ok) {
          const expBody = (await expRes.json()) as { experiment: ExperimentData };
          setSelectedExp(expBody.experiment);
        }
      }
      await loadExperiments();
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setRunning(false);
    }
  }

  // Prepare chart data for Shapley attribution
  const chartData = selectedExp?.shapley
    ? Object.entries(selectedExp.shapley).map(([key, val]) => {
        const interval = selectedExp.shapleyIntervals?.[key];
        const lower = interval ? Math.round(interval.lower * 100) : Math.round(val * 100);
        const upper = interval ? Math.round(interval.upper * 100) : Math.round(val * 100);
        const estimate = Math.round(val * 100);
        return {
          name: key.replace(/^config\./, '').replace(/^deps\./, ''),
          rawKey: key,
          attribution: estimate,
          ci: [lower, upper],
          errorLower: estimate - lower,
          errorUpper: upper - estimate,
        };
      })
    : [];

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/80 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100 flex items-center gap-3">
            <Cpu className="w-6 h-6 text-sky-400" />
            Freeze-Replay Grid & Shapley Attribution
          </h1>
          <p className="text-sm text-muted mt-1">
            Deterministic $2^k$ factorial replay testing isolates multi-parameter interaction culprits that
            single-variable bisect cannot find.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => handleRunReplay()}
            disabled={running || selectedExp?.status === 'running'}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition-all disabled:opacity-50"
          >
            {running || selectedExp?.status === 'running' ? (
              <RotateCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4 fill-current" />
            )}
            Run Replay on Active Incident
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl border border-rose-500/40 bg-rose-950/30 text-rose-300 text-sm flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Experiment Status Banner if running */}
      {selectedExp && (selectedExp.status === 'queued' || selectedExp.status === 'running') && (
        <div className="p-5 rounded-2xl bg-sky-950/40 border border-sky-800/60 flex items-center gap-4">
          <RotateCw className="w-6 h-6 text-sky-400 animate-spin shrink-0" />
          <div>
            <div className="font-semibold text-sky-200">Replay Experiment in Progress...</div>
            <div className="text-xs text-sky-300/80">
              Evaluating all {selectedExp.units.length > 0 ? 1 << selectedExp.units.length : 'factorial'} coalitions
              across test corpus with memoization in replayCache.
            </div>
          </div>
        </div>
      )}

      {/* Main Experiment View */}
      {selectedExp && selectedExp.status === 'done' ? (
        <div className="space-y-6">
          {/* Top Attribution & Recommendation Summary */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Shapley Chart */}
            <div className="lg:col-span-2 p-6 rounded-2xl bg-card border border-border shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-medium text-slate-200">Shapley Value Attribution</h3>
                  <p className="text-xs text-muted">
                    Blame shares across all {selectedExp.grid?.length ?? 8} replay coalitions with 95% bootstrap CI (credit assignment over replay results, not proof of causation)
                  </p>
                </div>
                <div className="text-xs font-mono px-2.5 py-1 rounded bg-slate-800 text-sky-400 border border-slate-700">
                  Total shift: {(selectedExp.totalShift * 100).toFixed(0)}%
                </div>
              </div>

              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                    <XAxis type="number" domain={[0, 100]} unit="%" stroke="#64748b" fontSize={11} />
                    <YAxis dataKey="name" type="category" stroke="#94a3b8" fontSize={12} width={90} />
                    <Tooltip
                      content={({ payload }) => {
                        if (!payload || !payload.length) return null;
                        const data = payload[0]!.payload as {
                          rawKey: string;
                          attribution: number;
                          ci: [number, number];
                        };
                        return (
                          <div className="bg-slate-900 border border-slate-700 p-2.5 rounded shadow-lg text-xs space-y-1">
                            <p className="font-semibold text-slate-200">{data.rawKey}</p>
                            <p className="text-sky-400 font-bold">{data.attribution}% Attribution</p>
                            <p className="text-muted text-[11px]">95% CI: [{data.ci[0]}%, {data.ci[1]}%]</p>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="attribution" radius={[0, 4, 4, 0]}>
                      {chartData.map((entry, index) => {
                        const isCulprit = selectedExp.culprits.includes(entry.rawKey);
                        return <Cell key={`cell-${index}`} fill={isCulprit ? '#f43f5e' : '#38bdf8'} />;
                      })}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Required Caveat Text */}
              <div className="p-2.5 rounded-lg bg-slate-900/60 border border-border/80 text-[11px] text-muted flex items-start gap-2 italic">
                <Info className="w-3.5 h-3.5 text-sky-400 shrink-0 mt-0.5 not-italic" />
                <span>{selectedExp.caveat}</span>
              </div>

              <div className="flex items-center justify-between text-xs text-muted border-t border-border pt-3">
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-rose-500" />
                    Culprit parameter
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-sky-400" />
                    Decoy / safe parameter
                  </span>
                </div>
                <span className="font-mono text-slate-400">
                  {selectedExp.method === 'sampled' ? selectedExp.methodNote : 'Exact 2^k Combinatorial Method'}
                </span>
              </div>
            </div>

            {/* Recommendation & Diagnosis */}
            <div className="p-6 rounded-2xl bg-card border border-border shadow-sm flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-rose-400 font-medium text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  Root Cause Diagnosis
                </div>
                <p className="text-sm text-slate-300 leading-relaxed">{selectedExp.recommendation}</p>
              </div>

              {/* Pairwise Interaction Stats */}
              {selectedExp.pairwiseInteractions && selectedExp.pairwiseInteractions.length > 0 && (
                <div className="space-y-2 pt-3 border-t border-border">
                  <div className="text-xs font-medium text-muted uppercase tracking-wider">Pairwise Interactions</div>
                  <div className="space-y-1">
                    {selectedExp.pairwiseInteractions.map((pi, idx) => (
                      <div key={idx} className="flex justify-between items-center text-xs font-mono">
                        <span className="text-slate-400">
                          v({pi.pair.join(' × ')})
                        </span>
                        <span className={`font-bold ${pi.interaction > 0.3 ? 'text-rose-400' : 'text-slate-300'}`}>
                          {pi.interaction > 0 ? `+${pi.interaction.toFixed(2)}` : pi.interaction.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2 pt-3 border-t border-border">
                <div className="text-xs font-medium text-muted uppercase tracking-wider">Memoization Performance</div>
                <div className="flex justify-between text-xs font-mono text-slate-400">
                  <span>Cache Hits: <strong className="text-emerald-400">{selectedExp.cacheHitsCount}</strong></span>
                  <span>Agent Calls: <strong className="text-sky-400">{selectedExp.agentCallsCount}</strong></span>
                </div>
              </div>
            </div>
          </div>

          {/* Factorial Grid Matrix */}
          <div className="p-6 rounded-2xl bg-card border border-border shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-medium text-slate-200 flex items-center gap-2">
                  <Layers className="w-5 h-5 text-sky-400" />
                  Factorial Permutation Grid ({selectedExp.grid?.length ?? 8} Coalitions)
                </h3>
                <p className="text-xs text-muted mt-0.5">
                  Wilson 95% score confidence intervals. Verdict marked inconclusive if bounds overlap baseline.
                </p>
              </div>
              <span className="text-xs font-mono text-muted">Incident: {selectedExp.incidentId.slice(0, 16)}</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border/80 text-muted">
                    <th className="py-2.5 px-3 font-medium">Mask</th>
                    <th className="py-2.5 px-3 font-medium">Active Changes Coalition</th>
                    <th className="py-2.5 px-3 font-medium text-right">Evals</th>
                    <th className="py-2.5 px-3 font-medium text-right">Violations</th>
                    <th className="py-2.5 px-3 font-medium">Wilson 95% CI</th>
                    <th className="py-2.5 px-3 font-medium text-right">Verdict</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40 font-mono">
                  {selectedExp.grid?.map((c) => {
                    const isFailing = c.verdict === 'failing';
                    const isInconclusive = c.verdict === 'inconclusive';

                    return (
                      <tr
                        key={c.mask}
                        className={`hover:bg-slate-800/40 transition-colors ${
                          isFailing
                            ? 'bg-rose-950/15'
                            : isInconclusive
                            ? 'bg-amber-950/10'
                            : 'bg-transparent'
                        }`}
                      >
                        <td className="py-2.5 px-3 text-sky-400 font-bold">{c.mask}</td>
                        <td className="py-2.5 px-3">
                          {c.activeUnits.length === 0 ? (
                            <span className="text-muted italic font-sans">Baseline (∅)</span>
                          ) : (
                            <div className="flex flex-wrap gap-1 font-sans">
                              {c.activeUnits.map((ch) => (
                                <span
                                  key={ch}
                                  className={`px-1.5 py-0.5 rounded text-[11px] font-mono border ${
                                    selectedExp.culprits.includes(ch)
                                      ? 'bg-rose-950/70 border-rose-800/60 text-rose-300'
                                      : 'bg-slate-800 border-slate-700 text-slate-300'
                                  }`}
                                >
                                  {ch}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right text-slate-300">{c.evaluations}</td>
                        <td className="py-2.5 px-3 text-right font-bold text-slate-200">
                          <span className={isFailing ? 'text-rose-400' : 'text-emerald-400'}>
                            {c.violationsCount}
                          </span>
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2">
                            <span className="text-slate-300">
                              {(c.violationRate * 100).toFixed(0)}%
                            </span>
                            <span className="text-[11px] text-muted">
                              [{(c.wilson.lower * 100).toFixed(0)}%, {(c.wilson.upper * 100).toFixed(0)}%]
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {isFailing ? (
                            <span className="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-rose-950/80 text-rose-300 border border-rose-800">
                              Failing
                            </span>
                          ) : isInconclusive ? (
                            <span className="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-amber-950/80 text-amber-300 border border-amber-800">
                              Inconclusive
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-emerald-950/80 text-emerald-300 border border-emerald-800">
                              OK
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-12 text-center rounded-2xl bg-card border border-border space-y-4">
          <Cpu className="w-10 h-10 text-muted mx-auto" />
          <h3 className="text-base font-medium text-slate-200">No Replay Experiments Run Yet</h3>
          <p className="text-xs text-muted max-w-md mx-auto">
            Click &quot;Bad deploy&quot; in the header above to trigger the silent regression, then run a replay
            experiment to isolate the multi-variable culprit using Shapley values.
          </p>
          <button
            onClick={() => handleRunReplay()}
            disabled={running}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition-all disabled:opacity-50"
          >
            {running ? <RotateCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
            Analyze Active Incident
          </button>
        </div>
      )}
    </div>
  );
}
