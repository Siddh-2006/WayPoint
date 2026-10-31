import React from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';

export interface RunItem {
  runId: string;
  projectId: string;
  contextHash: string;
  status: 'completed' | 'failed' | 'running';
  violations?: Array<{ rule?: string; message?: string }>;
  startedAt: string;
  inputId?: string;
}

interface LivePageProps {
  runs: RunItem[];
  sseStatus: 'connected' | 'reconnecting' | 'disconnected';
}

export function LivePage({ runs, sseStatus }: LivePageProps) {
  // Compute recent failure trend
  const trendData = React.useMemo(() => {
    const buckets: Record<string, { total: number; failed: number }> = {};
    for (const r of runs.slice(-30)) {
      const time = new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      if (!buckets[time]) buckets[time] = { total: 0, failed: 0 };
      buckets[time].total++;
      if (r.status === 'failed' || (r.violations && r.violations.length > 0)) {
        buckets[time].failed++;
      }
    }

    return Object.entries(buckets).map(([time, data]) => ({
      time,
      rate: Math.round((data.failed / Math.max(1, data.total)) * 100),
    }));
  }, [runs]);

  return (
    <div className="space-y-6">
      {/* Header Stat & Sparkline */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
          <div className="text-sm font-medium text-muted uppercase tracking-wider">Stream Status</div>
          <div className="mt-2 flex items-center gap-3">
            <span
              className={`w-3 h-3 rounded-full ${
                sseStatus === 'connected'
                  ? 'bg-emerald-500 animate-pulse'
                  : sseStatus === 'reconnecting'
                    ? 'bg-amber-500 animate-ping'
                    : 'bg-rose-500'
              }`}
            />
            <span className="text-xl font-semibold capitalize text-slate-100">{sseStatus}</span>
          </div>
          <div className="mt-2 text-xs text-muted">
            Backed by MongoDB Change Streams with automatic backoff reconnection
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
          <div className="text-sm font-medium text-muted uppercase tracking-wider">Total Runs Observed</div>
          <div className="mt-2 text-3xl font-bold text-sky-400">{runs.length}</div>
          <div className="mt-2 text-xs text-muted">
            {runs.filter((r) => r.status === 'failed' || (r.violations && r.violations.length > 0)).length} flagged silent failures
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div className="text-sm font-medium text-muted uppercase tracking-wider">Failure Rate Sparkline</div>
          <div className="h-16 w-full mt-2">
            {trendData.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData}>
                  <defs>
                    <linearGradient id="rateGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.6} />
                      <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '8px', fontSize: '12px' }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <Area type="monotone" dataKey="rate" stroke="#f43f5e" strokeWidth={2} fillOpacity={1} fill="url(#rateGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-muted italic">
                Awaiting run events to draw rate curve...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Runs Table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-100">Live Run Timeline</h2>
          <span className="text-xs text-muted font-mono">Real-time SSE feed</span>
        </div>

        {runs.length === 0 ? (
          <div className="p-12 text-center text-muted text-sm">
            No runs observed yet. Click one of the scenario buttons in the top bar to trigger execution.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900/60 text-xs font-semibold text-muted uppercase tracking-wider border-b border-border">
                <tr>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Run ID</th>
                  <th className="px-6 py-3">Context Hash</th>
                  <th className="px-6 py-3">Input ID</th>
                  <th className="px-6 py-3">Violations</th>
                  <th className="px-6 py-3">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {runs.slice(-25).reverse().map((run) => {
                  const hasViolations = Boolean(run.violations && run.violations.length > 0);
                  const isFailed = run.status === 'failed' || hasViolations;

                  return (
                    <tr key={run.runId} className="hover:bg-slate-800/40 transition-colors">
                      <td className="px-6 py-3.5">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            isFailed
                              ? 'bg-rose-950/80 text-rose-300 border border-rose-800'
                              : 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                          }`}
                        >
                          {isFailed ? 'VIOLATION' : 'CLEAN'}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 font-mono text-xs text-slate-300">{run.runId}</td>
                      <td className="px-6 py-3.5 font-mono text-xs text-sky-400">
                        {run.contextHash ? run.contextHash.slice(0, 10) + '…' : '—'}
                      </td>
                      <td className="px-6 py-3.5 font-mono text-xs text-slate-400">{run.inputId ?? '—'}</td>
                      <td className="px-6 py-3.5">
                        {hasViolations ? (
                          <span className="text-xs font-medium text-rose-400">
                            {run.violations!.length} rule breach{run.violations!.length > 1 ? 'es' : ''}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">0</span>
                        )}
                      </td>
                      <td className="px-6 py-3.5 text-xs text-muted">
                        {new Date(run.startedAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

