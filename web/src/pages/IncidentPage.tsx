import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock, ArrowRight, ShieldAlert, CheckCircle2 } from 'lucide-react';

export interface IncidentItem {
  id: string;
  projectId: string;
  baselineHash: string;
  badHash: string;
  changes: Array<{
    axis: string;
    path: string;
    before: unknown;
    after: unknown;
    summary: string;
  }>;
  evidenceRunIds: string[];
  violationSummary: Record<string, number>;
  rate: number;
  status: 'open' | 'resolved';
  openedAt: string;
}

interface IncidentPageProps {
  incidents: IncidentItem[];
}

export function IncidentPage({ incidents }: IncidentPageProps) {
  const [selectedIncidentId, setSelectedIncidentId] = React.useState<string | null>(null);

  // Fetch from API to ensure fresh data
  const { data: apiData } = useQuery<{ incidents: IncidentItem[] }>({
    queryKey: ['incidents'],
    queryFn: async () => {
      const res = await fetch('/v1/incidents?projectId=demo');
      if (!res.ok) {
        // Fallback to invoice-demo if demo is empty
        const fallback = await fetch('/v1/incidents?projectId=invoice-demo');
        return fallback.json();
      }
      const json = await res.json();
      if (!json.incidents || json.incidents.length === 0) {
        const fallback = await fetch('/v1/incidents');
        return fallback.json();
      }
      return json;
    },
    refetchInterval: 3000,
  });

  const allIncidents = apiData?.incidents && apiData.incidents.length > 0 ? apiData.incidents : incidents;
  const activeIncident = allIncidents.find((i) => i.id === selectedIncidentId) ?? allIncidents[0];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-border">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-rose-400" />
            Detected Incidents
          </h1>
          <p className="text-xs text-muted mt-1">
            Real-time silent failure detection comparing production runs against established baseline contracts
          </p>
        </div>
        <div className="text-xs font-mono px-3 py-1.5 rounded-lg bg-slate-900 border border-border text-slate-300">
          Open Incidents: {allIncidents.filter((i) => i.status === 'open').length}
        </div>
      </div>

      {allIncidents.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-16 text-center space-y-3">
          <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto" />
          <h3 className="text-base font-semibold text-slate-200">No Incidents Detected</h3>
          <p className="text-sm text-muted max-w-md mx-auto">
            All deployed contexts are currently operating within established contract invariants. Click "Bad deploy"
            above to trigger a simulated model/prompt regression.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Incident List */}
          <div className="space-y-3">
            <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Incident Queue</h2>
            {allIncidents.map((inc) => {
              const isSelected = activeIncident?.id === inc.id;
              return (
                <button
                  key={inc.id}
                  onClick={() => setSelectedIncidentId(inc.id)}
                  className={`w-full text-left p-4 rounded-xl border transition-all ${
                    isSelected
                      ? 'bg-rose-950/30 border-rose-600/70 shadow-sm'
                      : 'bg-card border-border hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs mb-2">
                    <span className="font-mono text-rose-400 font-semibold">
                      {(inc.rate * 100).toFixed(0)}% FAILURE RATE
                    </span>
                    <span className="text-muted flex items-center gap-1 font-mono">
                      <Clock className="w-3 h-3" />
                      {new Date(inc.openedAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="font-mono text-xs text-slate-300 truncate">
                    Bad Hash: {inc.badHash.slice(0, 12)}…
                  </div>
                  <div className="text-xs text-muted mt-1">
                    {inc.evidenceRunIds.length} evidence runs cited
                  </div>
                </button>
              );
            })}
          </div>

          {/* Incident Detail */}
          {activeIncident && (
            <div className="lg:col-span-2 space-y-6">
              {/* Incident Summary Card */}
              <div className="bg-card border border-rose-900/50 rounded-xl p-6 shadow-sm space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-border">
                  <div>
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-950 text-rose-300 border border-rose-800">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      SILENT CONTRACT REGRESSION
                    </div>
                    <h2 className="text-lg font-bold text-slate-100 mt-2">
                      Violation Rate: {(activeIncident.rate * 100).toFixed(0)}%
                    </h2>
                  </div>
                  <div className="flex flex-col sm:items-end gap-2">
                    <button
                      onClick={async () => {
                        const targetId = (activeIncident as any)._id ?? activeIncident.id;
                        try {
                          await fetch(`/v1/incidents/${targetId}/resolve`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              fix: 'Always enforce camelCase parameter naming in tool calls: use invoiceId, not invoice_id.',
                            }),
                          });
                          alert('Incident resolved and saved as episodic lesson in memory!');
                        } catch (e) {
                          alert('Failed to resolve incident: ' + String(e));
                        }
                      }}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-colors flex items-center gap-1.5"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Resolve & Save Lesson
                    </button>
                    <div className="text-xs font-mono text-muted">
                      Project: {activeIncident.projectId}
                    </div>
                  </div>
                </div>

                {/* Hashes comparison */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
                  <div className="p-3 bg-slate-900/80 rounded-lg border border-border">
                    <div className="text-muted text-[11px] uppercase tracking-wider mb-1">Baseline Context</div>
                    <div className="text-emerald-400 truncate">{activeIncident.baselineHash}</div>
                  </div>
                  <div className="p-3 bg-slate-900/80 rounded-lg border border-border">
                    <div className="text-muted text-[11px] uppercase tracking-wider mb-1">Regression Context</div>
                    <div className="text-rose-400 truncate">{activeIncident.badHash}</div>
                  </div>
                </div>

                {/* Violation Rules Breakdown */}
                <div>
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                    Violation Rule Summary
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {Object.entries(activeIncident.violationSummary).map(([rule, count]) => (
                      <div key={rule} className="p-3 bg-slate-900/60 rounded-lg border border-border">
                        <div className="text-lg font-bold text-rose-400">{count}</div>
                        <div className="text-[11px] text-muted font-mono truncate">{rule}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Typed Change List */}
                <div>
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                    Root Cause Context Diff ({activeIncident.changes.length} changes)
                  </h3>
                  <div className="space-y-2">
                    {activeIncident.changes.map((ch, idx) => (
                      <div key={idx} className="p-3 bg-slate-900/70 border border-border rounded-lg text-xs">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="uppercase text-[10px] font-bold px-2 py-0.5 rounded bg-sky-950 text-sky-300 border border-sky-800">
                            {ch.axis}
                          </span>
                          <span className="font-mono text-slate-300">{ch.path}</span>
                        </div>
                        <div className="text-slate-400 mt-1">{ch.summary}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Evidence Runs */}
                <div>
                  <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                    Evidence Run Citations ({activeIncident.evidenceRunIds.length} runs)
                  </h3>
                  <div className="p-3 bg-slate-950 rounded-lg border border-border max-h-48 overflow-y-auto space-y-2">
                    {activeIncident.evidenceRunIds.slice(0, 10).map((runId) => (
                      <div key={runId} className="flex items-center justify-between text-xs py-1 px-2 rounded hover:bg-slate-900 font-mono">
                        <span className="text-slate-300">{runId}</span>
                        <span className="text-rose-400 font-semibold">
                          key invoiceId missing; found invoice_id
                        </span>
                      </div>
                    ))}
                    {activeIncident.evidenceRunIds.length > 10 && (
                      <div className="text-[11px] text-muted text-center pt-1">
                        + {activeIncident.evidenceRunIds.length - 10} additional evidence runs recorded
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

