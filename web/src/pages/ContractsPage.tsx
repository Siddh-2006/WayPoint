import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileCode2, Check, ShieldCheck } from 'lucide-react';

interface Contract {
  projectId: string;
  tool: string;
  requiredKeys: string[];
  types: Record<string, string[]>;
  support: Record<string, number>;
  minedFrom?: { hash: string; runs: number };
  minedAt?: string;
}

export function ContractsPage() {
  const { data, isLoading } = useQuery<{ contracts: Contract[] }>({
    queryKey: ['contracts'],
    queryFn: async () => {
      const res = await fetch('/v1/contracts?projectId=demo');
      if (!res.ok) {
        const fallback = await fetch('/v1/contracts?projectId=invoice-demo');
        return fallback.json();
      }
      const json = await res.json();
      if (!json.contracts || json.contracts.length === 0) {
        const fallback = await fetch('/v1/contracts?projectId=invoice-demo');
        return fallback.json();
      }
      return json;
    },
    refetchInterval: 5000,
  });

  const contracts = data?.contracts ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-border">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
            Mined Tool Invariant Contracts
          </h1>
          <p className="text-xs text-muted mt-1">
            Empirically mined parameter contracts with support threshold &gt;= 98% from verified baseline runs
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center text-sm text-muted">
          Loading active contracts...
        </div>
      ) : contracts.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-16 text-center space-y-3">
          <FileCode2 className="w-12 h-12 text-muted mx-auto" />
          <h3 className="text-base font-semibold text-slate-200">No Contracts Mined Yet</h3>
          <p className="text-sm text-muted max-w-md mx-auto">
            Run the "Good" scenario above to establish baseline runs and automatically mine tool argument invariants.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          {contracts.map((c) => (
            <div key={`${c.projectId}_${c.tool}`} className="bg-card border border-border rounded-xl p-6 shadow-sm space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-border">
                <div>
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-300 border border-emerald-800">
                    <Check className="w-3.5 h-3.5" />
                    INVARIANT ACTIVE
                  </div>
                  <h2 className="text-lg font-bold text-slate-100 mt-2 font-mono">
                    Tool: {c.tool}
                  </h2>
                </div>
                {c.minedFrom && (
                  <div className="text-xs font-mono text-muted text-right">
                    <div>Mined From: {c.minedFrom.runs} baseline runs</div>
                    <div className="text-[11px] text-slate-500 truncate max-w-xs mt-0.5">
                      Hash: {c.minedFrom.hash.slice(0, 14)}…
                    </div>
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">
                  Arguments Invariant Support Matrix
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono">
                    <thead className="bg-slate-900/60 text-muted uppercase tracking-wider border-b border-border">
                      <tr>
                        <th className="px-4 py-2.5">Key Name</th>
                        <th className="px-4 py-2.5">Requirement</th>
                        <th className="px-4 py-2.5">Support Level</th>
                        <th className="px-4 py-2.5">Observed Types</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {Object.entries(c.support).map(([key, sup]) => {
                        const isRequired = c.requiredKeys.includes(key);
                        const types = c.types[key] ?? ['any'];

                        return (
                          <tr key={key} className="hover:bg-slate-800/30">
                            <td className="px-4 py-2.5 font-semibold text-slate-200">{key}</td>
                            <td className="px-4 py-2.5">
                              {isRequired ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-950 text-rose-300 border border-rose-800">
                                  REQUIRED (&gt;=98%)
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-400">
                                  OPTIONAL
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                <div className="w-24 bg-slate-800 h-2 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${isRequired ? 'bg-emerald-500' : 'bg-slate-500'}`}
                                    style={{ width: `${Math.min(100, sup * 100)}%` }}
                                  />
                                </div>
                                <span className="text-slate-300">{(sup * 100).toFixed(1)}%</span>
                              </div>
                            </td>
                            <td className="px-4 py-2.5 text-slate-400">
                              {types.join(', ')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

