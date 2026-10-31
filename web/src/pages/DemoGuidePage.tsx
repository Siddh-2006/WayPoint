import React from 'react';
import { Play, CheckCircle2, AlertCircle, ArrowRight, RotateCcw, Shield, ExternalLink, Info } from 'lucide-react';

export function DemoGuidePage() {
  const [sessionId, setSessionId] = React.useState<string>('');
  const [projectId, setProjectIdState] = React.useState<string>(() => sessionStorage.getItem('waypoint_demo_project') || '');
  const projectRef = React.useRef<string>(sessionStorage.getItem('waypoint_demo_project') || '');

  const setProjectId = React.useCallback((pid: string) => {
    projectRef.current = pid;
    setProjectIdState(pid);
    sessionStorage.setItem('waypoint_demo_project', pid);
  }, []);

  const [stepStatus, setStepStatus] = React.useState<Record<number, 'idle' | 'running' | 'done' | 'error'>>({
    1: 'idle',
    2: 'idle',
    3: 'idle',
    4: 'idle',
    5: 'idle',
    6: 'idle',
  });
  const [logs, setLogs] = React.useState<Record<number, string>>({});
  const [activeIncidentId, setActiveIncidentId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let sid = sessionStorage.getItem('waypoint_demo_session');
    if (!sid) {
      sid = crypto.randomUUID();
      sessionStorage.setItem('waypoint_demo_session', sid);
    }
    setSessionId(sid);
  }, []);

  const getHeaders = React.useCallback(() => {
    return {
      'Content-Type': 'application/json',
      'x-demo-session': sessionId || sessionStorage.getItem('waypoint_demo_session') || '',
    };
  }, [sessionId]);

  // Step 1: Reset Sandbox
  const handleReset = async () => {
    setStepStatus((s) => ({ ...s, 1: 'running' }));
    try {
      const res = await fetch('/v1/demo/story/reset', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reset sandbox');
      setProjectId(data.projectId);
      setStepStatus((s) => ({ ...s, 1: 'done' }));
      setLogs((l) => ({ ...l, 1: `Sandbox reset! Project: ${data.projectId} | Seeded ${data.baselineRunsSeeded} baseline runs` }));
    } catch (err: any) {
      setStepStatus((s) => ({ ...s, 1: 'error' }));
      setLogs((l) => ({ ...l, 1: err.message }));
    }
  };

  // Step 2: Establish Good Baseline
  const handleBaseline = async () => {
    setStepStatus((s) => ({ ...s, 2: 'running' }));
    try {
      const activePid = projectRef.current || projectId;
      const res = await fetch('/v1/demo/run', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ scenarioId: 'good', projectId: activePid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to run baseline');
      setStepStatus((s) => ({ ...s, 2: 'done' }));
      setLogs((l) => ({ ...l, 2: `Clean baseline executed: 20/20 runs passed. Contract mined for create_invoice.` }));
    } catch (err: any) {
      setStepStatus((s) => ({ ...s, 2: 'error' }));
      setLogs((l) => ({ ...l, 2: err.message }));
    }
  };

  // Step 3: Bad Deploy
  const handleBadDeploy = async () => {
    setStepStatus((s) => ({ ...s, 3: 'running' }));
    try {
      const activePid = projectRef.current || projectId;
      const res = await fetch('/v1/demo/run', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ scenarioId: 'bad_deploy', projectId: activePid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed bad deploy');

      // Fetch incident with quick retries for detector change stream propagation
      let inc: any = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const incRes = await fetch(`/v1/incidents?projectId=${activePid}`, { headers: getHeaders() });
        const incData = await incRes.json();
        inc = incData.incidents?.[0];
        if (inc) {
          setActiveIncidentId(inc._id || inc.incidentId);
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      setStepStatus((s) => ({ ...s, 3: 'done' }));
      setLogs((l) => ({ ...l, 3: `Bad deploy triggered: Silent failures detected! Incident opened${inc ? ` (${inc._id})` : ''}.` }));
    } catch (err: any) {
      setStepStatus((s) => ({ ...s, 3: 'error' }));
      setLogs((l) => ({ ...l, 3: err.message }));
    }
  };

  // Step 4: Replay & Shapley Blame
  const handleReplay = async () => {
    setStepStatus((s) => ({ ...s, 4: 'running' }));
    try {
      const activePid = projectRef.current || projectId;
      let incId = activeIncidentId;
      if (!incId) {
        const incRes = await fetch(`/v1/incidents?projectId=${activePid}`, { headers: getHeaders() });
        const incData = await incRes.json();
        incId = incData.incidents?.[0]?._id;
        if (!incId) throw new Error('No incident found. Complete Step 3 first.');
        setActiveIncidentId(incId);
      }

      const res = await fetch(`/v1/incidents/${incId}/replay`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Replay experiment failed');

      setStepStatus((s) => ({ ...s, 4: 'done' }));
      setLogs((l) => ({
        ...l,
        4: `Replay grid complete! Evaluated ${data.grid?.length ?? 4} cells. Culprits: [${data.culprits?.join(', ')}]. Shapley attribution: ${JSON.stringify(data.shapley)}.`,
      }));
    } catch (err: any) {
      setStepStatus((s) => ({ ...s, 4: 'error' }));
      setLogs((l) => ({ ...l, 4: err.message }));
    }
  };

  // Step 5: Resolve Incident & Save Lesson
  const handleResolve = async () => {
    setStepStatus((s) => ({ ...s, 5: 'running' }));
    try {
      const activePid = projectRef.current || projectId;
      let incId = activeIncidentId;
      if (!incId) {
        const incRes = await fetch(`/v1/incidents?projectId=${activePid}`, { headers: getHeaders() });
        const incData = await incRes.json();
        incId = incData.incidents?.[0]?._id;
        if (!incId) throw new Error('No incident found. Complete Step 3 first.');
      }

      const res = await fetch(`/v1/incidents/${incId}/resolve`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          fix: 'Enforce camelCase parameter naming in tool arguments',
          source: 'incident',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resolve incident');

      setStepStatus((s) => ({ ...s, 5: 'done' }));
      setLogs((l) => ({ ...l, 5: `Incident resolved! Stored lesson ${data._id} with symptom & culprit units.` }));
    } catch (err: any) {
      setStepStatus((s) => ({ ...s, 5: 'error' }));
      setLogs((l) => ({ ...l, 5: err.message }));
    }
  };

  // Step 6: Preflight Proposed v3
  const handlePreflight = async () => {
    setStepStatus((s) => ({ ...s, 6: 'running' }));
    try {
      const activePid = projectRef.current || projectId;
      const proposedV3 = {
        model: 'v3',
        promptText: 'Extract invoice line items with high precision and compute subtotals accurately.',
        config: { chunkSize: 512, temperature: 0.1 },
        toolSchemas: { create_invoice: { type: 'function' } },
        deps: { extractor: '1.0.0' },
      };

      const res = await fetch('/v1/preflight', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ projectId: activePid, proposedContext: proposedV3 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preflight check failed');

      const isBlock = data.verdict === 'block';
      const structuralReason = data.reasons?.find((r: string) => r.includes('Structural:') || r.includes('same rule'));

      setStepStatus((s) => ({ ...s, 6: isBlock ? 'done' : 'error' }));
      setLogs((l) => ({
        ...l,
        6: `Verdict: ${data.verdict.toUpperCase()}\nReplay violations: ${data.replay?.violationsCount}/${data.replay?.evaluations}\n${structuralReason ? `Citation: ${structuralReason}` : 'Reasons: ' + data.reasons?.join('\n')}`,
      }));
    } catch (err: any) {
      setStepStatus((s) => ({ ...s, 6: 'error' }));
      setLogs((l) => ({ ...l, 6: err.message }));
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-2xl font-bold text-slate-100">Waypoint Interactive Demo Story</h1>
              <span className="px-2 py-0.5 text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded">
                PER-SESSION SANDBOX
              </span>
              <span className="px-2 py-0.5 text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded">
                SIMULATED AGENT
              </span>
            </div>
            <p className="text-slate-400 text-sm mt-1">
              Follow this 6-step workflow to witness Waypoint detect silent regressions, isolate culprits via Shapley attribution, and stop bad deployments with episodic memory.
            </p>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <div>
            <span className="text-slate-500">Session ID:</span> <code className="text-slate-300 font-mono">{sessionId || 'initializing...'}</code>
          </div>
          <div>
            <span className="text-slate-500">Sandbox Project:</span> <code className="text-indigo-400 font-mono">{projectId || 'none (press Step 1)'}</code>
          </div>
        </div>
      </div>

      {/* Steps List */}
      <div className="space-y-4">
        {/* Step 1 */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-sm">
                1
              </div>
              <div>
                <h3 className="font-semibold text-slate-200">Reset & Seed Sandbox</h3>
                <p className="text-xs text-slate-400">Creates isolated workspace, seeds clean baseline runs & historical lessons.</p>
              </div>
            </div>
            <button
              data-testid="step-1-btn"
              onClick={handleReset}
              disabled={stepStatus[1] === 'running'}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition flex items-center space-x-1.5 disabled:opacity-50"
            >
              {stepStatus[1] === 'running' ? <RotateCcw className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              <span>Reset Sandbox</span>
            </button>
          </div>
          {logs[1] && <div className="mt-3 p-3 bg-slate-950 rounded border border-slate-800 text-xs font-mono text-emerald-400">{logs[1]}</div>}
        </div>

        {/* Step 2 */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-sm">
                2
              </div>
              <div>
                <h3 className="font-semibold text-slate-200">Run Good Baseline</h3>
                <p className="text-xs text-slate-400">Executes 20 invoices with model v1 + camelCase guard. Mines strict contract.</p>
              </div>
            </div>
            <button
              data-testid="step-2-btn"
              onClick={handleBaseline}
              disabled={stepStatus[2] === 'running'}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium transition flex items-center space-x-1.5 disabled:opacity-50"
            >
              {stepStatus[2] === 'running' ? <RotateCcw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              <span>Run Baseline</span>
            </button>
          </div>
          {logs[2] && <div className="mt-3 p-3 bg-slate-950 rounded border border-slate-800 text-xs font-mono text-emerald-400">{logs[2]}</div>}
        </div>

        {/* Step 3 */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-sm">
                3
              </div>
              <div>
                <h3 className="font-semibold text-slate-200">Trigger Bad Deploy (Silent Failures)</h3>
                <p className="text-xs text-slate-400">Upgrades to model v2 and removes camelCase line. Live detector flags incident.</p>
              </div>
            </div>
            <button
              data-testid="step-3-btn"
              onClick={handleBadDeploy}
              disabled={stepStatus[3] === 'running'}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition flex items-center space-x-1.5 disabled:opacity-50"
            >
              {stepStatus[3] === 'running' ? <RotateCcw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              <span>Bad Deploy</span>
            </button>
          </div>
          {logs[3] && <div className="mt-3 p-3 bg-slate-950 rounded border border-slate-800 text-xs font-mono text-amber-400">{logs[3]}</div>}
        </div>

        {/* Step 4 */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-sm">
                4
              </div>
              <div>
                <h3 className="font-semibold text-slate-200">Factorial Replay & Shapley Blame</h3>
                <p className="text-xs text-slate-400">Replays all factor combinations over test corpus. Fairly attributes blame.</p>
              </div>
            </div>
            <button
              data-testid="step-4-btn"
              onClick={handleReplay}
              disabled={stepStatus[4] === 'running'}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium transition flex items-center space-x-1.5 disabled:opacity-50"
            >
              {stepStatus[4] === 'running' ? <RotateCcw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              <span>Run Replay Grid</span>
            </button>
          </div>
          {logs[4] && <div className="mt-3 p-3 bg-slate-950 rounded border border-slate-800 text-xs font-mono text-cyan-400">{logs[4]}</div>}
        </div>

        {/* Step 5 */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-sm">
                5
              </div>
              <div>
                <h3 className="font-semibold text-slate-200">Resolve Incident & Save Lesson</h3>
                <p className="text-xs text-slate-400">Records symptom, fix, culprit units & violated rule references to episodic memory.</p>
              </div>
            </div>
            <button
              data-testid="step-5-btn"
              onClick={handleResolve}
              disabled={stepStatus[5] === 'running'}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium transition flex items-center space-x-1.5 disabled:opacity-50"
            >
              {stepStatus[5] === 'running' ? <RotateCcw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>Resolve & Save</span>
            </button>
          </div>
          {logs[5] && <div className="mt-3 p-3 bg-slate-950 rounded border border-slate-800 text-xs font-mono text-emerald-400">{logs[5]}</div>}
        </div>

        {/* Step 6 */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 border-l-4 border-l-rose-500">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center font-bold text-sm">
                6
              </div>
              <div>
                <h3 className="font-semibold text-slate-200">Preflight Check Proposed v3 (The Finale)</h3>
                <p className="text-xs text-slate-400">Proposes model v3 without camelCase rule. Waypoint intercepts and BLOCKs the change!</p>
              </div>
            </div>
            <button
              data-testid="step-6-btn"
              onClick={handlePreflight}
              disabled={stepStatus[6] === 'running'}
              className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-sm font-medium transition flex items-center space-x-1.5 disabled:opacity-50"
            >
              {stepStatus[6] === 'running' ? <RotateCcw className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
              <span>Preflight v3</span>
            </button>
          </div>
          {logs[6] && (
            <div className="mt-3 p-3 bg-slate-950 rounded border border-rose-900/50 text-xs font-mono text-rose-300 whitespace-pre-wrap">
              {logs[6]}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

