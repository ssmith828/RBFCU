// ───────────────────────────────────────────────────────────────────────────────
// File: src/types.ts
// ───────────────────────────────────────────────────────────────────────────────

export type OrchestratorPhase =
  | "idle"
  | "getting_token"
  | "dialing_leg1"
  | "waiting_agent_answered"
  | "dialing_leg3"
  | "active"
  | "ended"
  | "error";

export type Participant = {
  id: string;
  kind: "sip" | "webrtc" | "other";
  displayName?: string;
  isVideo: boolean;
  isConnected: boolean;
};

export type RosterSnapshot = {
  participants: Participant[];
  counts: {
    webrtcVideo: number;
    sipVideo: number;
  };
};

export type PexipConfig = {
  nodeUrl: string;
  extraHeaders?: Record<string, string>;
};

export type StartParams = {
  sessionAlias: string;
  displayName?: string;

  /** LEG 1 custom header: agent user ID (UUID) sent as X-agent-id */
  agentUserId?: string;

  /** LEG 1 custom header: queue ID (UUID) sent as X-queue-id */
  queueId?: string;

  /** LEG 1: destination (contact center SIP URI) */
  contactCenterAlias: string;

  /** LEG 3: destination (external VTC alias/VMR/existing endpoint). */
  secondDialAlias: string;

  /** Optional room/VMR PIN for request_token (sent as HTTP header "pin") */
  pin?: string;

  /** Optional per-call customer SIP domain to help form routable candidates for Leg 3 */
  customerSipDomain?: string;
};

export interface OrchestratorEvents {
  phase: (phase: OrchestratorPhase) => void;
  roster: (roster: RosterSnapshot) => void;
  active: (payload: { active: boolean; roster: RosterSnapshot }) => void;
  error: (err: Error) => void;
}
export type Listener<K extends keyof OrchestratorEvents> = OrchestratorEvents[K];
