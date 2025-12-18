// ───────────────────────────────────────────────────────────────────────────────
// File: src/orchestrator.ts
// Orchestrator for multi-leg flow (Leg 0..3) with clean ESLint handling
// ───────────────────────────────────────────────────────────────────────────────

import type {
  OrchestratorPhase,
  PexipConfig,
  RosterSnapshot,
  StartParams,
  Participant,
} from "./types";
import { PexipClient } from "./pexipClient";
import { PexipSSE } from "./sse";

type KeepConferenceAliveMode =
  | "keep_conference_alive"
  | "keep_conference_alive_if_multiple"
  | "keep_conference_alive_never";

type EventPayloads = {
  phase: OrchestratorPhase;
  roster: RosterSnapshot;
  active: { active: boolean; roster: RosterSnapshot };
  error: Error;
};
type EventKey = keyof EventPayloads;
type ListenerFn<K extends EventKey> = (p: EventPayloads[K]) => void;

type ListenerSets = {
  phase: Set<ListenerFn<"phase">>;
  roster: Set<ListenerFn<"roster">>;
  active: Set<ListenerFn<"active">>;
  error: Set<ListenerFn<"error">>;
};

function normAlias(s: string): string {
  return s.trim().toLowerCase().replace(/^sip:/, "");
}
function matchesSipAlias(p: Participant, alias: string): boolean {
  if (p.kind !== "sip") return false;
  const dn = (p.displayName ?? "").toString();
  if (!dn) return false;
  return normAlias(dn).includes(normAlias(alias));
}

// ------- minimal local mappers (no any) -------
function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }
  return false;
}
function getString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function hasMediaType(list: unknown, type: "audio" | "video"): boolean {
  if (!Array.isArray(list)) return false;
  return list.some((item) => isRecord(item) && getString(item["type"])?.toLowerCase() === type);
}
function mapRawParticipant(r: Record<string, unknown>): Participant | null {
  const id =
    getString(r["participant_uuid"]) ||
    getString(r["uuid"]) ||
    getString(r["id"]);
  if (!id) return null;

  const displayName =
    getString(r["display_name"]) ||
    getString(r["name"]) ||
    getString(r["participant_name"]);

  const proto = getString(r["protocol"])?.toLowerCase();
  const kind: Participant["kind"] =
    proto === "webrtc" || proto === "web" || proto === "browser"
      ? "webrtc"
      : proto === "sip" || proto === "sips"
      ? "sip"
      : "other";

  const isConnected =
    toBool(r["is_connected"]) ||
    toBool(r["connected"]) ||
    (r["is_connected"] === undefined && r["connected"] === undefined);

  const hasVideo =
    toBool(r["has_video"]) ||
    toBool(r["video"]) ||
    toBool(r["is_video"]) ||
    hasMediaType(r["streams"], "video") ||
    hasMediaType(r["media"], "video");

  return { id, displayName, kind, isConnected, isVideo: hasVideo };
}

// Expose a typed window shim instead of any
declare global {
  interface Window {
    __agentDial?: {
      getState: () => {
        alias: string | null;
        token: string | null;
        phase: OrchestratorPhase;
        leg3Dialed: boolean;
        agentReady: boolean;
        stopped: boolean;
      };
    };
  }
}

export class Orchestrator {
  private client: PexipClient;
  private sse: PexipSSE;
  private token: string | null = null;
  private currentAlias: string | null = null;

  private listeners: ListenerSets = {
    phase: new Set(),
    roster: new Set(),
    active: new Set(),
    error: new Set(),
  };

  private phase: OrchestratorPhase = "idle";

  // remember params for resume/retry
  private lastStartParams: StartParams | null = null;

  // guards
  private agentReady = false;   // Leg 1 SIP is up AND Leg 2 WebRTC is up
  private leg3Dialed = false;   // idempotent guard for Leg 3
  private stopped = false;
  private inactiveSince: number | null = null;

  // "min two" presence guard
  private minTwoArmed = false;
  private belowTwoSince: number | null = null;

  // SSE grace
  private sseGraceUntil = 0;
  private lastConnectedCount = 0;

  // 4-legs/20s rule
  private fullyEngagedSince: number | null = null;
  private killOnAgentDropArmed = false;

  // Leg 3 retry
  private pendingLeg3Retry?: number;

  // Leg 0 retirement controls
  private leg0Retired = false;
  private retireAfterMs = 8000; // stabilization window after all 4 legs are up
  private fourLegsSince: number | null = null;

  constructor(cfg: PexipConfig) {
    this.client = new PexipClient(cfg);
    this.sse = new PexipSSE(cfg.nodeUrl);

    // expose for support tools (typed)
    window.__agentDial = {
      getState: () => this.getDebugState(),
    };
  }

  // Events
  on<K extends EventKey>(ev: K, fn: ListenerFn<K>) {
    const set = this.listeners[ev] as unknown as Set<ListenerFn<K>>;
    set.add(fn);
    return () => set.delete(fn);
  }
  private emit<K extends EventKey>(ev: K, payload: EventPayloads[K]) {
    const set = this.listeners[ev] as unknown as Set<ListenerFn<K>>;
    set.forEach((listener) => listener(payload));
  }
  private setPhase(p: OrchestratorPhase) {
    this.phase = p;
    this.emit("phase", p);
  }

  // ---------- Public helpers ----------
  public getDebugState() {
    return {
      alias: this.currentAlias,
      token: this.token,
      phase: this.phase,
      leg3Dialed: this.leg3Dialed,
      agentReady: this.agentReady,
      stopped: this.stopped,
    };
  }

  /** Poll server and reconcile. */
  public async refreshFromServer(): Promise<void> {
    if (!this.token || !this.currentAlias) return;
    try {
      const json: unknown = await this.client.listParticipants(this.token, this.currentAlias);
      this.ingestParticipantsSnapshot(json);
      this.ensureLeg3IfAgentReady();
    } catch (err) {
      console.warn("[agent-dial] refreshFromServer failed", err);
    }
  }

  /**
   * Accept raw /participants response and rebuild roster.
   * Supports shapes { result: [...] } or [].
   */
  public ingestParticipantsSnapshot(raw: unknown) {
    let list: unknown = raw;
    if (isRecord(raw) && Array.isArray((raw as Record<string, unknown>).result)) {
      list = (raw as Record<string, unknown>).result;
    }
    if (!Array.isArray(list)) return;

    const participants: Participant[] = [];
    for (const item of list) {
      if (!isRecord(item)) continue;
      const p = mapRawParticipant(item);
      if (p) participants.push(p);
    }

    const snapshot: RosterSnapshot = {
      participants,
      counts: {
        webrtcVideo: participants.filter((p) => p.kind === "webrtc" && p.isConnected && p.isVideo)
          .length,
        sipVideo: participants.filter((p) => p.kind === "sip" && p.isConnected && p.isVideo)
          .length,
      },
    };

    if (this.lastStartParams) {
      void this.onRoster(snapshot, this.lastStartParams);
    } else {
      this.emit("roster", snapshot);
    }
  }

  /** Idempotent Leg 3 guard. */
  public ensureLeg3IfAgentReady() {
    if (this.stopped || this.leg3Dialed || !this.agentReady || !this.lastStartParams) return;
    void this.tryDialLeg3WithCandidates(this.lastStartParams);
  }

  // ---------- Flow ----------
  async start(params: StartParams) {
    try {
      this.lastStartParams = { ...params };
      this.agentReady = false;
      this.leg3Dialed = false;
      this.stopped = false;
      this.inactiveSince = null;
      this.minTwoArmed = false;
      this.belowTwoSince = null;
      this.sseGraceUntil = 0;
      this.lastConnectedCount = 0;
      this.fullyEngagedSince = null;
      this.killOnAgentDropArmed = false;
      this.currentAlias = params.sessionAlias;

      // reset retirement trackers
      this.leg0Retired = false;
      this.fourLegsSince = null;

      // Leg 0: Request token
      this.setPhase("getting_token");
      const { token } = await this.client.requestToken(
        params.sessionAlias,
        params.displayName,
        params.pin
      );
      this.token = token;

      // Start SSE early
      this.sse.connect(params.sessionAlias, token, (r) => this.onRoster(r, this.lastStartParams!));

      if (this.stopped) return;

      // Leg 1: SIP audio to contact center — enforce protocol AUTO
      this.setPhase("dialing_leg1");

      // Build custom SIP headers (lowercase after the leading 'X-')
      const custom: Record<string, string> = {};
      if (params.agentUserId && String(params.agentUserId).trim()) {
        custom["X-agent-id"] = String(params.agentUserId).trim();
      }
      if (params.queueId && String(params.queueId).trim()) {
        custom["X-queue-id"] = String(params.queueId).trim();
      }

      const leg1Opts: {
        role: "HOST";
        callType: "audio";
        sourceDisplayName?: string;
        localAlias?: string;
        customHeaders?: Record<string, string>;
        keepConferenceAlive?: KeepConferenceAliveMode;
      } = {
        role: "HOST",
        callType: "audio",
        sourceDisplayName: params.sessionAlias,
        localAlias: params.sessionAlias,
        customHeaders: Object.keys(custom).length ? custom : undefined,
      };

      await this.client.dial(
        this.token,
        params.sessionAlias,
        params.contactCenterAlias,
        "auto",
        leg1Opts
      );

      this.setPhase("waiting_agent_answered");
    } catch (err) {
      console.error("[agent-dial] start error:", err);
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.setPhase("error");
    }
  }

  stop() {
    this.stopped = true;
    this.sse.close();
    this.setPhase("ended");
    console.info("[agent-dial]", "SSE closed; phase ended");
  }

  async hardEnd() {
    try {
      if (this.token && this.currentAlias) {
        console.info("[agent-dial]", "hardEnd -> disconnect_all");
        await this.client.disconnectAll(this.token, this.currentAlias);
      }
    } finally {
      this.stop();
      this.currentAlias = null;
      this.token = null;
    }
  }

  // ---------- Internals ----------
  private async tryDialLeg3WithCandidates(params: StartParams) {
    if (!this.token) return;
    this.leg3Dialed = true; // optimistic

    this.setPhase("dialing_leg3");

    const destRaw = params.secondDialAlias.trim();
    const hasAt = destRaw.includes("@");
    const looksSip = /^sip:/i.test(destRaw);

    // Optional domain to form candidates when user typed only a short alias
    const customerSipDomain =
      typeof (params as Record<string, unknown>)["customerSipDomain"] === "string" &&
      String((params as Record<string, unknown>)["customerSipDomain"]).trim()
        ? String((params as Record<string, unknown>)["customerSipDomain"]).trim()
        : undefined;

    const leg3Opts = {
      role: "HOST" as const,
      callType: "video" as const,
      sourceDisplayName: params.displayName || "Genesys Widget",
      localAlias: params.sessionAlias,
    };

    // Candidate list: try both raw and SIP-prefixed forms; protocol AUTO handles routing
    const candidates: string[] = [];
    if (looksSip) {
      candidates.push(destRaw);
      const stripped = destRaw.replace(/^sip:/i, "");
      if (stripped) candidates.push(stripped);
    } else if (hasAt) {
      candidates.push(destRaw);
      candidates.push(`sip:${destRaw}`);
    } else {
      if (customerSipDomain) {
        candidates.push(`${destRaw}@${customerSipDomain}`);
        candidates.push(`sip:${destRaw}@${customerSipDomain}`);
      }
      candidates.push(destRaw);
      candidates.push(`sip:${destRaw}`);
    }

    let success = false;
    let lastErr: unknown = null;

    for (const dest of candidates) {
      try {
        const created = await this.client.dial(
          this.token!,
          params.sessionAlias,
          dest,
          "auto",
          leg3Opts
        );
        if (created.length > 0) {
          success = true;
          break;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    if (!success) {
      this.leg3Dialed = false;

      if (!this.pendingLeg3Retry) {
        this.pendingLeg3Retry = window.setTimeout(() => {
          this.pendingLeg3Retry = undefined;
          if (!this.stopped && this.agentReady && !this.leg3Dialed && this.lastStartParams) {
            void this.tryDialLeg3WithCandidates(this.lastStartParams);
          }
        }, 2500);
      }

      const err =
        lastErr instanceof Error
          ? lastErr
          : new Error(
              "Leg 3 could not be routed. Provide a routable alias/URI or verify server routing rules."
            );
      this.emit("error", err);
      this.setPhase("waiting_agent_answered");
      return;
    }
  }

  /** Retire Leg 0: stop SSE, release token; do NOT disconnect the conference. */
  private async retireLeg0(): Promise<void> {
    if (this.leg0Retired) return;
    this.leg0Retired = true;
    try {
      // Close SSE first so we stop reacting to roster during release
      this.sse.close();

      if (this.token && this.currentAlias) {
        console.info("[agent-dial]", "Retiring Leg 0 (release_token) for", this.currentAlias);
        await this.client.releaseToken(this.token, this.currentAlias);
      }

      // mark as stopped so onRoster doesn't run any more logic
      this.stopped = true;

      // we intentionally DO NOT call disconnect_all; just end the widget session
      this.setPhase("ended");
      console.info("[agent-dial]", "Leg 0 retired; widget ended, conference persists.");
    } catch (err) {
      console.warn("[agent-dial] retireLeg0 failed (non-fatal)", err);
      // Even if release fails, we still stop reacting in this widget
      this.stopped = true;
      this.setPhase("ended");
    } finally {
      // clear local references
      this.currentAlias = null;
      this.token = null;
    }
  }

  private async onRoster(roster: RosterSnapshot, params: StartParams) {
    if (this.stopped) return;

    this.emit("roster", roster);

    const participants = roster.participants;
    const now = Date.now();
    const connectedCount = participants.filter((p) => p.isConnected).length;

    // Dormancy grace
    if (this.lastConnectedCount > 0 && connectedCount === 0) {
      this.sseGraceUntil = now + 8000;
    }
    this.lastConnectedCount = connectedCount;

    // "min two" rule (any 2 connected legs keep the session alive at start)
    if (!this.minTwoArmed && connectedCount >= 2) {
      this.minTwoArmed = true;
      this.belowTwoSince = null;
    }
    if (this.minTwoArmed && connectedCount < 2 && now >= this.sseGraceUntil) {
      if (this.belowTwoSince == null) this.belowTwoSince = now;
      if (now - this.belowTwoSince > 1500) {
        try {
          await this.hardEnd();
        } catch (err) {
          console.warn("[agent-dial] hardEnd failed (ignored, min-two path)", err);
        }
        return;
      }
    } else {
      this.belowTwoSince = null;
    }

    // Leg presence checks
    const leg1SipUp = participants.some(
      (p) => p.isConnected === true && matchesSipAlias(p, params.contactCenterAlias)
    );
    const leg2WebrtcUp =
      participants.some((p) => p.kind === "webrtc" && p.isConnected === true && p.isVideo === true) ||
      participants.some((p) => p.kind === "webrtc" && p.isConnected === true);
    const leg3SipUp = participants.some(
      (p) => p.isConnected === true && matchesSipAlias(p, params.secondDialAlias)
    );
    const leg0ApiUp = participants.some((p) => p.isConnected === true && p.kind === "other");

    // Agent readiness = Leg 1 (SIP) + Leg 2 (WebRTC)
    if (!this.agentReady && leg1SipUp && leg2WebrtcUp) {
      this.agentReady = true;
      this.ensureLeg3IfAgentReady();
    }

    // "Active" when Leg 2 (agent WebRTC) and Leg 3 (customer VTC) are both up
    if (leg2WebrtcUp && leg3SipUp && this.phase !== "active") {
      this.setPhase("active");
      this.emit("active", { active: true, roster });
    }

    // 4-legs / 20s rule: once all legs are up for 20s, arm kill on agent drop
    const fourLegsUp = leg0ApiUp && leg1SipUp && leg2WebrtcUp && leg3SipUp;
    if (fourLegsUp) {
      if (this.fullyEngagedSince == null) {
        this.fullyEngagedSince = now;
      } else if (!this.killOnAgentDropArmed && now - this.fullyEngagedSince >= 20000) {
        this.killOnAgentDropArmed = true;
      }
    } else {
      if (!this.killOnAgentDropArmed) this.fullyEngagedSince = null;
    }

    if (this.killOnAgentDropArmed && (!leg1SipUp || !leg2WebrtcUp)) {
      try {
        await this.hardEnd();
      } catch (err) {
        console.warn("[agent-dial] hardEnd failed (ignored, agent-drop path)", err);
      }
      return;
    }

    // Track continuous 4-legs uptime for Leg 0 retirement
    if (fourLegsUp) {
      if (this.fourLegsSince == null) this.fourLegsSince = now;
    } else {
      this.fourLegsSince = null;
    }

    // Retire Leg 0 once 4 legs have been stable long enough and we still have core hosts
    if (
      !this.leg0Retired &&
      fourLegsUp &&
      this.fourLegsSince !== null &&
      now - this.fourLegsSince >= this.retireAfterMs &&
      leg1SipUp &&
      leg2WebrtcUp
    ) {
      await this.retireLeg0();
      return;
    }

    // Idle termination
    if (connectedCount === 0) {
      if (this.inactiveSince == null) this.inactiveSince = now;
      if (now - this.inactiveSince > 3000 && now >= this.sseGraceUntil) {
        this.stop();
      }
    } else {
      this.inactiveSince = null;
    }
  }
}

export default Orchestrator;
