// src/sse.ts
// Pexip SSE client (Client REST API v2)
// - Uses EventSource with ?token= on the URL (browsers can't set headers on SSE)
// - Emits normalized roster snapshots matching src/types.ts
// - Self-heals: periodic emits, dormancy reconnect, backoff with jitter
// - Lint-clean (no any), typed helpers, optional reconnectNow/updateAuth

import type { Participant, RosterSnapshot } from "./types";

type PexipEventName =
  | "participant_update"
  | "participant_delete"
  | "participant_sync_begin"
  | "participant_sync_end"
  | "conference_update"
  | "layout"
  | "message_received"
  | "stage"
  | "call_disconnected"
  | "disconnect"
  | string;

type RawParticipant = {
  participant_uuid?: unknown;
  uuid?: unknown;
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  participant_name?: unknown;
  protocol?: unknown;
  is_connected?: unknown;
  connected?: unknown;
  has_video?: unknown;
  video?: unknown;
  is_video?: unknown;
  streams?: unknown;
  media?: unknown;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
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
function hasMediaType(list: unknown, type: "audio" | "video"): boolean {
  if (!Array.isArray(list)) return false;
  return list.some(
    (item) => isRecord(item) && getString(item["type"])?.toLowerCase() === type
  );
}

/** Map a raw Pexip payload into our strong Participant type. */
function toParticipant(raw: RawParticipant): Participant | null {
  const id = getString(raw.participant_uuid) || getString(raw.uuid) || getString(raw.id);
  if (!id) return null;

  const displayName =
    getString(raw.display_name) ||
    getString(raw.name) ||
    getString(raw.participant_name);

  const proto = getString(raw.protocol)?.toLowerCase();
  const normalized: Participant["kind"] =
    proto === "webrtc" || proto === "web" || proto === "browser"
      ? "webrtc"
      : proto === "sip" || proto === "sips"
      ? "sip"
      : "other";

  const isConnected =
    toBool(raw.is_connected) ||
    toBool(raw.connected) ||
    (raw.is_connected === undefined && raw.connected === undefined);

  const hasVideo =
    toBool(raw.has_video) ||
    toBool(raw.video) ||
    toBool(raw.is_video) ||
    hasMediaType(raw.streams, "video") ||
    hasMediaType(raw.media, "video");

  return {
    id,
    displayName,
    kind: normalized,
    isConnected,
    isVideo: hasVideo,
  };
}

export class PexipSSE {
  private es?: EventSource;
  private roster = new Map<string, Participant>();

  // auth
  private alias: string | null = null;
  private token: string | null = null;

  // self-heal fields
  private lastEventAt = 0;

  // Timers
  private tickTimer: number | null = null;          // soft heartbeat emitter
  private dormancyTimer: number | null = null;      // checks idle -> triggers reconnect
  private reconnectTimeout: number | null = null;   // delayed reconnect

  private backoffMs = 2000;
  private firstEventLogged = false;

  constructor(private nodeUrl: string) {}

  /** Update alias/token without reconnecting immediately. */
  updateAuth(alias: string, token: string) {
    this.alias = alias;
    this.token = token;
  }

  /** Force a reconnect using the current alias/token. */
  reconnectNow(onRoster: (r: RosterSnapshot) => void) {
    this.internalReconnect(0, onRoster);
  }

  connect(alias: string, token: string, onRoster: (r: RosterSnapshot) => void) {
    this.close(); // fully reset timers/stream

    this.alias = alias;
    this.token = token;
    this.lastEventAt = Date.now();
    this.backoffMs = 2000;
    this.firstEventLogged = false;

    const url = `${this.nodeUrl}/api/client/v2/conferences/${encodeURIComponent(
      alias
    )}/events?token=${encodeURIComponent(token)}`;

    this.es = new EventSource(url);

    const emit = () => onRoster(this.toSnapshot());

    this.es.onopen = () => {
      console.info("[agent-dial]", "SSE open");
      this.lastEventAt = Date.now();
      emit(); // show initial roster immediately
    };

    this.es.onerror = (ev) => {
      console.warn("[agent-dial]", "SSE error", ev);
    };

    const upsert = (rec: Record<string, unknown>) => {
      const p = toParticipant(rec as RawParticipant);
      if (!p) return;
      this.roster.set(p.id, p);
      this.lastEventAt = Date.now();
    };

    const remove = (rec: Record<string, unknown>) => {
      const id =
        getString((rec as RawParticipant).participant_uuid) ||
        getString((rec as RawParticipant).uuid) ||
        getString((rec as RawParticipant).id);
      if (id) this.roster.delete(id);
      this.lastEventAt = Date.now();
    };

    // --- Named SSE events (preferred) ---
    const parseAndApply = (jsonText: string) => {
      try {
        const data = JSON.parse(jsonText) as unknown;
        if (!isRecord(data)) return;

        if (!this.firstEventLogged) {
          this.firstEventLogged = true;
          console.debug("[agent-dial]", "SSE first event payload (sample)", data);
        }

        upsert(data);
        emit();
      } catch (e) {
        console.warn("[agent-dial]", "SSE named-event parse failed", e, jsonText);
      }
    };

    const onUpdateEvent = (evt: MessageEvent<string>) => {
      const data = evt.data;
      if (typeof data === "string") parseAndApply(data);
    };

    const onDeleteEvent = (evt: MessageEvent<string>) => {
      try {
        const dataText = evt.data;
        const data = JSON.parse(dataText) as unknown;
        if (isRecord(data)) {
          remove(data);
          emit();
        }
      } catch (e) {
        console.warn("[agent-dial]", "SSE participant_delete parse failed", e);
      }
    };

    const onSyncBeginEvent = () => {
      this.roster.clear();
      this.lastEventAt = Date.now();
    };

    const onSyncEndEvent = () => {
      this.lastEventAt = Date.now();
      emit();
    };

    this.es.addEventListener("participant_update", onUpdateEvent as EventListener);
    this.es.addEventListener("participant_delete", onDeleteEvent as EventListener);
    this.es.addEventListener("participant_sync_begin", onSyncBeginEvent as EventListener);
    this.es.addEventListener("participant_sync_end", onSyncEndEvent as EventListener);

    // --- Fallback: untyped messages ---
    this.es.onmessage = (evt: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(evt.data) as unknown;
        if (!isRecord(parsed)) return;

        const name = getString(parsed["event"]) as PexipEventName | undefined;
        const payload = isRecord(parsed["data"]) ? parsed["data"] : parsed;

        switch (name) {
          case "participant_sync_begin":
            this.roster.clear();
            this.lastEventAt = Date.now();
            return;

          case "participant_update":
            if (isRecord(payload)) {
              upsert(payload);
              emit();
            }
            return;

          case "participant_delete":
            if (isRecord(payload)) {
              remove(payload);
              emit();
            }
            return;

          case "participant_sync_end":
            this.lastEventAt = Date.now();
            emit();
            return;

          default:
            if (isRecord(payload) && (payload["participant_uuid"] || payload["uuid"] || payload["id"])) {
              upsert(payload);
              emit();
            }
        }
      } catch (e) {
        console.warn("[agent-dial]", "SSE message parse failed", e, evt.data);
      }
    };

    // --- Soft heartbeat & dormancy watchdog ---
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
    }
    this.tickTimer = window.setInterval(() => {
      emit();
    }, 2000);

    if (this.dormancyTimer !== null) {
      window.clearInterval(this.dormancyTimer);
    }
    this.dormancyTimer = window.setInterval(() => {
      const idleMs = Date.now() - this.lastEventAt;
      if (idleMs > 20_000) {
        const wait = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
        console.warn(
          "[agent-dial]",
          `SSE dormant (${Math.round(idleMs / 1000)}s) -> reconnecting in ${wait}ms`
        );
        this.internalReconnect(wait, onRoster);
      }
    }, 5_000);
  }

  private internalReconnect(delayMs: number, onRoster: (r: RosterSnapshot) => void) {
    const alias = this.alias;
    const token = this.token;
    if (!alias || !token) {
      console.warn("[agent-dial]", "SSE reconnect skipped (no alias/token)");
      return;
    }

    if (this.reconnectTimeout !== null) {
      window.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      this.es?.close();
    } catch (e) {
      console.debug("[agent-dial]", "SSE close (ignored)", e);
    }
    this.es = undefined;

    const base = Math.min(Math.max(delayMs, 500), 10_000);
    const jitter = Math.floor(Math.random() * Math.min(1_000, Math.max(250, base / 2)));
    const wait = base + jitter;

    console.info("[agent-dial]", `SSE reconnect scheduled in ~${wait}ms`);

    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      const currentAlias = this.alias;
      const currentToken = this.token;
      if (!currentAlias || !currentToken) {
        console.warn("[agent-dial]", "SSE reconnect aborted (alias/token cleared)");
        return;
      }
      this.connect(currentAlias, currentToken, onRoster);
    }, wait);
  }

  close() {
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.dormancyTimer !== null) {
      window.clearInterval(this.dormancyTimer);
      this.dormancyTimer = null;
    }
    if (this.reconnectTimeout !== null) {
      window.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.es) {
      try {
        this.es.close();
      } catch (e) {
        console.debug("[agent-dial]", "SSE close (ignored)", e);
      }
      this.es = undefined;
    }
    console.info("[agent-dial]", "SSE closed");
  }

  private toSnapshot(): RosterSnapshot {
    const participants = Array.from(this.roster.values());
    const counts = {
      webrtcVideo: participants.filter(
        (p) => p.kind === "webrtc" && p.isConnected && p.isVideo
      ).length,
      sipVideo: participants.filter(
        (p) => p.kind === "sip" && p.isConnected && p.isVideo
      ).length,
    };
    return { participants, counts };
  }
}
