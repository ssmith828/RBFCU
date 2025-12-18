// ───────────────────────────────────────────────────────────────────────────────
// File: src/App.tsx
// ───────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import type React from "react";
import PexOrchestrator from "./orchestrator";
import type {
  OrchestratorPhase,
  PexipConfig,
  RosterSnapshot,
  Participant,
} from "./types";
import { fetchRegisteredEndpoints } from "./api";
import type { DialOption } from "./api";
import { MasterVariables } from "./masterVariables";
import { getCurrentUserId, listMyQueues, type AgentQueue } from "./genesys";
import "./theme.css";

function StatusPill({ phase }: { phase: OrchestratorPhase }) {
  const map: Record<OrchestratorPhase, string> = {
    idle: "Idle",
    getting_token: "Session initiating…",
    dialing_leg1: "Dialing contact center…",
    waiting_agent_answered: "Waiting for agent to answer…",
    dialing_leg3: "Dialing destination (SIP)…",
    active: "Call active",
    ended: "Start call", // keep UI optimistic after retirement
    error: "Error",
  };
  return <span className="pill">{map[phase]}</span>;
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

export default function App() {
  // brand setup
  useEffect(() => {
    const b = MasterVariables.ui?.brand;
    if (!b) return;
    const r = document.documentElement.style;
    r.setProperty("--bg", b.bg);
    r.setProperty("--fg", b.fg);
    r.setProperty("--muted", b.muted);
    r.setProperty("--card", b.card);
    r.setProperty("--ring", b.ring);
    r.setProperty("--accent", b.accent);
    r.setProperty("--text-primary", b.textPrimary ?? b.fg);
    r.setProperty("--text-secondary", b.textSecondary ?? b.muted);
    r.setProperty("--text-on-accent", b.textOnAccent ?? "#000");
    r.setProperty("--text-error", b.errorText ?? "#ffb3a6");
  }, []);

  // toggles
  const showPexipServer = MasterVariables.ui?.toggles?.showPexipServer ?? true;
  const showManualAlias = MasterVariables.ui?.toggles?.showManualAlias ?? true;
  const showSessionAlias = MasterVariables.ui?.toggles?.showSessionAlias ?? true;

  // Form state
  const [sessionAlias, setSessionAlias] = useState(
    MasterVariables.conference?.randomAlias?.() ??
      `genesys-pex-${Math.random().toString(36).slice(2, 8)}`
  );
  const [pexipNodeUrl, setPexipNodeUrl] = useState(MasterVariables.pexip.nodeUrl);

  // Queues
  const [userId, setUserId] = useState<string>("");
  const [queues, setQueues] = useState<AgentQueue[]>([]);
  const [selectedQueueId, setSelectedQueueId] = useState<string>("");

  // External contacts
  const [endpoints, setEndpoints] = useState<DialOption[]>([]);
  const [selectedEndpoint, setSelectedEndpoint] = useState<string>("");

  // Optional manual alias
  const [manualAliases, setManualAliases] = useState<string>("");

  // Orchestrator state
  const [phase, setPhase] = useState<OrchestratorPhase>("idle");
  const [roster, setRoster] = useState<RosterSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pin = (MasterVariables.conference?.pin ?? "").toString();
  const contactCenterAlias = MasterVariables.dialPlan.contactCenterAlias;

  // orchestrator instance
  const orchestrator = useMemo(() => {
    const cfg: PexipConfig = { nodeUrl: pexipNodeUrl };
    return new PexOrchestrator(cfg);
  }, [pexipNodeUrl]);

  // Bootstrap: userId, queues, external contacts
  useEffect(() => {
    (async () => {
      try {
        const [uid, qs, options] = await Promise.all([
          getCurrentUserId(),
          listMyQueues(),
          fetchRegisteredEndpoints(),
        ]);

        setUserId(uid);

        // Default queue: pick a joined queue if present
        setQueues(qs);
        const joined = qs.find((q) => q.joined);
        setSelectedQueueId(joined?.id ?? qs[0]?.id ?? "");

        setEndpoints(options);
      } catch (err) {
        console.error("[agent-dial]", "bootstrap failed", err);
        setError(toMessage(err));
      }
    })();
  }, []);

  // subscribe to orchestrator events
  useEffect(() => {
    const offPhase = orchestrator.on("phase", setPhase);
    const offRoster = orchestrator.on("roster", setRoster);
    const offErr = orchestrator.on("error", (err: unknown) => setError(toMessage(err)));
    return () => {
      offPhase?.();
      offRoster?.();
      offErr?.();
    };
  }, [orchestrator]);

  // UI reset on end
  useEffect(() => {
    if (phase === "ended") {
      setSessionAlias(MasterVariables.conference.randomAlias());
      setSelectedEndpoint("");
    }
  }, [phase]);

  // helpers
  function parseManualAliases(raw: string): string[] {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  function resolveLeg3Destination(): string {
    const manual = parseManualAliases(manualAliases);
    if (manual.length > 0) return manual[0];
    return selectedEndpoint || endpoints[0]?.value || "";
  }

  // actions
  const initiate = async () => {
    setError(null);
    const second = resolveLeg3Destination();

    console.info("[agent-dial]", "initiate payload", {
      sessionAlias,
      agentUserId: userId,
      queueId: selectedQueueId,
      contactCenterAlias,
      secondDialAlias: second,
      pexipNodeUrl,
      hasPin: Boolean(pin),
      externalDisplayName: MasterVariables.ui?.externalDeviceDisplayName,
    });

    await orchestrator.start({
      sessionAlias,
      displayName: MasterVariables.ui?.externalDeviceDisplayName || "Genesys Widget",
      pin: pin || undefined,
      contactCenterAlias,
      secondDialAlias: second,
      agentUserId: userId,
      queueId: selectedQueueId,
    });
  };

  // render
  return (
    <div className="container grid gap-16">
      <header className="row justify-between">
        <h1 className="title title-brand">Initiate Scheduled Video Visit</h1>
        <StatusPill phase={phase} />
      </header>

      {phase === "idle" || phase === "error" || phase === "ended" ? (
        <div className="card grid gap-12" role="form" aria-label="Dialer form">
          {error && <div className="card error-card" role="alert">{error}</div>}

          {/* Pexip server (toggleable) */}
          {showPexipServer && (
            <div className="grid">
              <label className="label" htmlFor="pexipNodeUrl">Pexip Server</label>
              <input
                id="pexipNodeUrl"
                className="input"
                value={pexipNodeUrl}
                title="Pexip node base URL"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPexipNodeUrl(e.target.value)}
              />
            </div>
          )}

          {/* Session Alias (toggleable, read-only) */}
          {showSessionAlias && (
            <div className="grid">
              <label className="label" htmlFor="sessionAlias">Session Alias</label>
              <input
                id="sessionAlias"
                className="input"
                value={sessionAlias}
                readOnly
                title="Session alias used for the Pexip conference (auto-generated)"
              />
              <span className="label">Auto-generated (read-only)</span>
            </div>
          )}

          {/* Agent Queue dropdown */}
          <div className="grid">
            <label className="label" htmlFor="agentQueue">Agent Queue</label>
            <select
              id="agentQueue"
              className="select"
              aria-label="Agent queues"
              title="Select the queue to anchor the interaction"
              value={selectedQueueId}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedQueueId(e.target.value)}
            >
              <option value="">None</option>
              {queues.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}{q.joined ? " (current)" : ""}
                </option>
              ))}
            </select>
            <span className="label">
              Selected Queue ID: <span className="kbd">{selectedQueueId || "(none)"}</span>
            </span>
          </div>

          {/* Destination (External Contacts) */}
          <div className="grid">
            <label className="label" htmlFor="registeredEndpoint">Destination (External Contacts)</label>
            <select
              id="registeredEndpoint"
              className="select"
              aria-label="Registered endpoints"
              title="Select a branch/endpoint"
              value={selectedEndpoint}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedEndpoint(e.target.value)}
            >
              <option value="">None</option>
              {endpoints.map((opt) => (
                <option key={`${opt.label}::${opt.value}`} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <span className="label">Value sent: <span className="kbd">{selectedEndpoint || "(none)"}</span></span>
          </div>

          {/* Manual alias (toggleable) */}
          {showManualAlias && (
            <div className="grid">
              <label className="label" htmlFor="manualAliases">Manual alias (optional, overrides dropdown)</label>
              <input
                id="manualAliases"
                className="input"
                placeholder="0040030000, room@video.example.com"
                title="You can enter one or more aliases, separated by commas"
                value={manualAliases}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setManualAliases(e.target.value)}
              />
            </div>
          )}

          <div className="row justify-end gap-12">
            <button
              type="button"
              className="button button-reset"
              onClick={() => window.location.reload()}
              title="Reset this widget"
            >
              Reset
            </button>
            <button type="button" className="button button-primary" onClick={initiate}>
              Initiate
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-12">
          <div className="card grid gap-8">
            <div className="row justify-between">
              <div className="section-title">Session state</div>
              <StatusPill phase={phase} />
            </div>
            <div className="label">Current phase: <span className="kbd">{phase}</span></div>
          </div>

          <div className="card grid gap-8">
            <div className="section-title">Roster</div>
            {!roster ? (
              <div className="label">Waiting for events…</div>
            ) : (
              <ul className="grid gap-6">
                {roster.participants.map((p: Participant) => (
                  <li key={p.id} className="row">
                    <span className="pill pill-accent" aria-label={p.kind === "sip" ? "SIP participant" : "WebRTC participant"}>{p.kind}</span>
                    <span>{p.displayName || p.id}</span>
                    {!p.isConnected && <em className="label">(ringing)</em>}
                    {p.isVideo && <span className="label">• video</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="row gap-8">
            <button type="button" className="button button-secondary" onClick={() => orchestrator.stop()}>
              Reset (soft)
            </button>
            <button type="button" className="button button-secondary" onClick={() => orchestrator.hardEnd()}>
              End Session (disconnect all)
            </button>
          </div>
        </div>
      )}

      <footer className="label footer-note">
        This tool starts a Pexip session (Leg 0), dials the contact center (Leg 1) with custom headers,
        waits for the agent’s WebRTC (Leg 2), then dials the destination (Leg 3).
      </footer>
    </div>
  );
}
