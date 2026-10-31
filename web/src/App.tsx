import React from 'react';
import { Routes, Route, NavLink, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  FileCheck2,
  Cpu,
  BookOpen,
  ShieldCheck,
  Play,
  RotateCw,
  Compass,
} from 'lucide-react';
import { LivePage, type RunItem } from './pages/LivePage.js';
import { IncidentPage, type IncidentItem } from './pages/IncidentPage.js';
import { ContractsPage } from './pages/ContractsPage.js';
import { ExperimentsPage } from './pages/ExperimentsPage.js';
import { LessonsPage } from './pages/LessonsPage.js';
import { PreflightPage } from './pages/PreflightPage.js';

export default function App() {
  const navigate = useNavigate();
  const [runs, setRuns] = React.useState<RunItem[]>([]);
  const [incidents, setIncidents] = React.useState<IncidentItem[]>([]);
  const [sseStatus, setSseStatus] = React.useState<'connected' | 'reconnecting' | 'disconnected'>('reconnecting');
  const [runningScenario, setRunningScenario] = React.useState<string | null>(null);
  const [scenarioReadout, setScenarioReadout] = React.useState<string | null>(null);

  // SSE Stream with exponential backoff reconnect
  React.useEffect(() => {
    let es: EventSource | null = null;
    let reconnectDelay = 1000;
    let timer: NodeJS.Timeout | null = null;
    let isUnmounted = false;

    function connect() {
      if (isUnmounted) return;
      setSseStatus('reconnecting');

      es = new EventSource('/v1/stream');

      es.addEventListener('open', () => {
        if (!isUnmounted) {
          setSseStatus('connected');
          reconnectDelay = 1000;
        }
      });

      es.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'run' && payload.doc) {
            setRuns((prev) => {
              const exists = prev.some((r) => r.runId === payload.doc.runId);
              if (exists) {
                return prev.map((r) => (r.runId === payload.doc.runId ? payload.doc : r));
              }
              return [...prev, payload.doc];
            });
          } else if (payload.type === 'incident' && payload.doc) {
            setIncidents((prev) => {
              const id = payload.doc._id ?? payload.doc.id;
              const exists = prev.some((i) => i.id === id);
              if (exists) return prev.map((i) => (i.id === id ? { ...payload.doc, id } : i));
              return [{ ...payload.doc, id }, ...prev];
            });
          }
        } catch {
          // ignore malformed SSE messages
        }
      });

      es.addEventListener('error', () => {
        if (!isUnmounted) {
          setSseStatus('disconnected');
          if (es) {
            es.close();
            es = null;
          }
          timer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
            connect();
          }, reconnectDelay);
        }
      });
    }

    connect();

    return () => {
      isUnmounted = true;
      if (timer) clearTimeout(timer);
      if (es) es.close();
    };
  }, []);

  // Scenario Trigger
  async function triggerScenario(scenarioId: 'good' | 'bad_deploy' | 'model_only' | 'prompt_only', label: string) {
    setRunningScenario(scenarioId);
    setScenarioReadout(`Executing ${label} across 20 corpus inputs...`);

    try {
      const res = await fetch('/v1/demo/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId, projectId: 'demo' }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const body = await res.json();

      // If good scenario, server registers context and handles baseline setup
      setScenarioReadout(`✓ ${label} completed: 20 runs ingested (context: ${body.contextHash.slice(0, 8)}…)`);

      if (scenarioId === 'bad_deploy') {
        setTimeout(() => {
          navigate('/incidents');
        }, 800);
      }
    } catch (err) {
      setScenarioReadout(`Failed to execute ${label}: ${String(err)}`);
    } finally {
      setRunningScenario(null);
    }
  }

  return (
    <div className="min-h-screen bg-background text-slate-100 flex flex-col font-sans">
      {/* Top Navbar */}
      <header className="border-b border-border bg-card/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          {/* Logo & Badge */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-sky-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-sky-500/20">
              <Compass className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-base tracking-tight text-white">Waypoint</span>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-amber-950/80 text-amber-300 border border-amber-700/60">
                  SIMULATED AGENT
                </span>
              </div>
              <p className="text-[11px] text-muted hidden sm:block">Deterministic Silent Failure Recovery</p>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex items-center gap-1 sm:gap-2">
            <NavLink
              to="/"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  isActive ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' : 'text-slate-400 hover:text-slate-200'
                }`
              }
            >
              <Activity className="w-3.5 h-3.5" />
              Live
            </NavLink>

            <NavLink
              to="/incidents"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  isActive ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'text-slate-400 hover:text-slate-200'
                }`
              }
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              Incidents
            </NavLink>

            <NavLink
              to="/contracts"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  isActive ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-slate-400 hover:text-slate-200'
                }`
              }
            >
              <FileCheck2 className="w-3.5 h-3.5" />
              Contracts
            </NavLink>

            <NavLink
              to="/experiments"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  isActive ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' : 'text-slate-400 hover:text-slate-200'
                }`
              }
            >
              <Cpu className="w-3.5 h-3.5" />
              Experiments
            </NavLink>

            <NavLink
              to="/lessons"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  isActive ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : 'text-slate-400 hover:text-slate-200'
                }`
              }
            >
              <BookOpen className="w-3.5 h-3.5" />
              Lessons
            </NavLink>

            <NavLink
              to="/preflight"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  isActive ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-slate-400 hover:text-slate-200'
                }`
              }
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              Preflight
            </NavLink>
          </nav>

          {/* SSE Connection Status Pill */}
          <div className="flex items-center gap-2 font-mono text-xs text-muted">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                sseStatus === 'connected' ? 'bg-emerald-500' : sseStatus === 'reconnecting' ? 'bg-amber-500 animate-pulse' : 'bg-rose-500'
              }`}
            />
            <span className="hidden sm:inline capitalize">{sseStatus}</span>
          </div>
        </div>
      </header>

      {/* Scenario Control Panel */}
      <section className="bg-slate-900/80 border-b border-border py-3 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Play className="w-3.5 h-3.5 text-sky-400" />
              Demo Scenarios:
            </span>
            <span className="text-xs text-muted hidden lg:inline">
              (Server-side keys; safe for judge zero-config evaluation)
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => triggerScenario('good', 'Good Baseline')}
              disabled={Boolean(runningScenario)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-950/80 hover:bg-emerald-900 text-emerald-200 border border-emerald-700/60 transition-all disabled:opacity-50"
            >
              Good Baseline
            </button>

            <button
              id="btn-bad-deploy"
              onClick={() => triggerScenario('bad_deploy', 'Bad deploy')}
              disabled={Boolean(runningScenario)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-950/90 hover:bg-rose-900 text-rose-200 border border-rose-600/70 shadow-sm transition-all disabled:opacity-50 font-bold"
            >
              Bad deploy
            </button>

            <button
              onClick={() => triggerScenario('model_only', 'Model v2 Only')}
              disabled={Boolean(runningScenario)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-border transition-all disabled:opacity-50"
            >
              Model v2 Only
            </button>

            <button
              onClick={() => triggerScenario('prompt_only', 'Old Prompt Only')}
              disabled={Boolean(runningScenario)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-border transition-all disabled:opacity-50"
            >
              Old Prompt Only
            </button>

            {runningScenario && <RotateCw className="w-4 h-4 text-sky-400 animate-spin ml-1" />}
          </div>
        </div>

        {scenarioReadout && (
          <div className="max-w-7xl mx-auto mt-2 text-xs font-mono text-sky-300 bg-sky-950/30 px-3 py-1.5 rounded-md border border-sky-800/40">
            {scenarioReadout}
          </div>
        )}
      </section>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Routes>
          <Route path="/" element={<LivePage runs={runs} sseStatus={sseStatus} />} />
          <Route path="/incidents" element={<IncidentPage incidents={incidents} />} />
          <Route path="/contracts" element={<ContractsPage />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/lessons" element={<LessonsPage />} />
          <Route path="/preflight" element={<PreflightPage />} />
        </Routes>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/80 py-4 text-center text-xs text-muted">
        Waypoint • Autonomous Invariant Mining & Runtime Failure Attribution • MongoDB Hackathon
      </footer>
    </div>
  );
}

