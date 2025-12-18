// src/pexipClient.ts
// Pexip Client API wrapper for Client REST API v2 (alias-scoped endpoints).
// - Sends token in header "token"
// - keepalive token refresh with rotation
// - Dial always sends protocol: "auto" and supports keep_conference_alive
// - Custom SIP headers are sent in JSON field `custom_sip_headers`

import type { PexipConfig } from "./types";

export type KeepConferenceAliveMode =
  | "keep_conference_alive"
  | "keep_conference_alive_if_multiple"
  | "keep_conference_alive_never";

export type DialOptions = {
  role?: "HOST" | "GUEST";
  callType?: "audio" | "video" | "video-only";
  sourceDisplayName?: string;
  localAlias?: string;
  /**
   * Custom SIP headers for the dialed leg (e.g., { "X-dial-agent-ext": "1234" }).
   * These will be sent in the `custom_sip_headers` field of the /dial payload.
   */
  customHeaders?: Record<string, string>;
  /** Maps to JSON key keep_conference_alive */
  keepConferenceAlive?: KeepConferenceAliveMode;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function redactHeaders(h?: HeadersInit) {
  if (!h || typeof h !== "object") return h;
  const obj = { ...(h as Record<string, string>) };
  if ("Authorization" in obj) obj.Authorization = "<redacted>";
  if ("token" in obj) obj.token = "<redacted>";
  if ("pin" in obj) obj.pin = "<redacted>";
  return obj;
}

export class PexipClient {
  private keepAlive?: { timer: number; token: string; alias: string };

  constructor(private cfg: PexipConfig) {}

  private h(extra?: HeadersInit): HeadersInit {
    return { "Content-Type": "application/json", ...(extra || {}) };
  }

  /** Expose current token (rotated) to callers that need it for diagnostics. */
  public currentToken(): string | undefined {
    return this.keepAlive?.token;
  }

  /** Start/Restart token keepalive for a given alias. */
  private startKeepAlive(initialToken: string, alias: string) {
    this.stopKeepAlive();

    let liveToken = initialToken;
    const intervalMs = 55_000;

    // initialize before first tick
    this.keepAlive = { timer: 0, token: liveToken, alias };

    const tick = async () => {
      try {
        const url = `${this.cfg.nodeUrl}/api/client/v2/conferences/${encodeURIComponent(
          alias
        )}/refresh_token`;
        const headers = this.h({ token: liveToken });
        console.info("[agent-dial]", "refresh_token -> POST", url);
        const res = await fetch(url, { method: "POST", headers });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error("[agent-dial]", "token refresh failed", res.status, text);
          return; // try again on next interval
        }
        const jsonUnknown = (await res.json().catch(() => ({}))) as unknown;
        if (!isRecord(jsonUnknown)) return;
        const result = isRecord(jsonUnknown.result) ? jsonUnknown.result : {};
        const newToken =
          typeof result.token === "string" && result.token.length > 0 ? result.token : "";

        if (newToken && newToken !== liveToken) {
          liveToken = newToken;
          if (this.keepAlive) this.keepAlive.token = liveToken;
          console.debug("[agent-dial]", "token refresh ok (rotated)");
        } else {
          console.debug("[agent-dial]", "token refresh ok");
        }
      } catch (e) {
        console.warn("[agent-dial]", "token refresh network issue (will retry)", e);
      }
    };

    // fire once immediately, then schedule
    void tick();
    const timer = window.setInterval(tick, intervalMs);
    this.keepAlive.timer = timer;
  }

  private stopKeepAlive() {
    if (this.keepAlive?.timer) {
      window.clearInterval(this.keepAlive.timer);
    }
    this.keepAlive = undefined;
  }

  /**
   * Request a client token for a given conference alias.
   * For PIN-protected conferences, provide PIN in HTTP header "pin".
   */
  async requestToken(alias: string, displayName?: string, pin?: string): Promise<{ token: string; expires?: number }> {
    const url = `${this.cfg.nodeUrl}/api/client/v2/conferences/${encodeURIComponent(
      alias
    )}/request_token`;
    const headers: HeadersInit = this.h(pin?.trim() ? { pin: pin.trim() } : {});
    const body = { display_name: displayName || "Agent Dialer" };

    console.info("[agent-dial]", "request_token -> POST", url);
    console.debug("[agent-dial]", "request_token headers=", redactHeaders(headers), "body=", body);

    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      console.error("[agent-dial]", "request_token network error:", e);
      throw new Error("Network error calling request_token (CORS/TLS/DNS/firewall?)");
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[agent-dial]", "request_token HTTP", res.status, "body=", text);
      throw new Error(`request_token failed: ${res.status} ${text || res.statusText}`);
    }

    const jsonUnknown = (await res.json().catch(() => ({}))) as unknown;
    if (!isRecord(jsonUnknown)) throw new Error("Unexpected response to request_token");

    const result = isRecord(jsonUnknown.result) ? jsonUnknown.result : {};
    const token = typeof result.token === "string" ? result.token : "";
    const expiresRaw = result.expires;

    if (!token) {
      console.error("[agent-dial]", "request_token returned no token:", jsonUnknown);
      throw new Error("request_token returned no token. Check alias or policy.");
    }

    this.startKeepAlive(token, alias);

    const expires =
      typeof expiresRaw === "number"
        ? expiresRaw
        : typeof expiresRaw === "string"
        ? Number(expiresRaw) || undefined
        : undefined;

    return { token, expires };
  }

  /**
   * Conference -> dial out (alias-scoped, header "token").
   * Returns: array of created participant UUIDs (empty array means no route was created).
   *
   * NOTE: We will **always** send protocol: "auto" to let the node select the best route.
   * IMPORTANT: custom headers go into `custom_sip_headers` which is the required format for dial API call.
   */
  async dial(
    token: string,
    alias: string,
    destination: string,
    _protocol?: "auto" | "sip" | "h323" | "mssip" | "rtmp" | "webrtc",
    opts?: DialOptions
  ): Promise<string[]> {
    const liveToken = this.currentToken() || token;
    const url = `${this.cfg.nodeUrl}/api/client/v2/conferences/${encodeURIComponent(
      alias
    )}/dial`;

    const payload: Record<string, unknown> = {
      destination,
      protocol: "auto", // <- enforce AUTO every time
    };
    if (opts?.role) payload.role = opts.role;
    if (opts?.callType) payload.call_type = opts.callType;
    if (opts?.sourceDisplayName) payload.source_display_name = opts.sourceDisplayName;
    if (opts?.localAlias && opts.localAlias.trim()) {
      payload.local_alias = opts.localAlias.trim();
    }

    // IMPORTANT: use `custom_sip_headers` to match Pexip API scope 
    if (opts?.customHeaders && Object.keys(opts.customHeaders).length > 0) {
      payload.custom_sip_headers = opts.customHeaders;
    }

    if (opts?.keepConferenceAlive) {
      payload.keep_conference_alive = opts.keepConferenceAlive;
    }

    const headers = this.h({ token: liveToken });

    console.info("[agent-dial]", "dial -> POST", url);
    console.debug("[agent-dial]", "dial headers=", redactHeaders(headers), "payload=", payload);

    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (e) {
      console.error("[agent-dial]", "dial network error:", e);
      throw new Error("Network/CORS error on dial.");
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[agent-dial]", "dial HTTP", res.status, "body=", text);
      throw new Error(`dial failed: ${res.status} ${text || res.statusText}`);
    }

    const json: unknown = await res.json().catch(() => ({}));
    if (isRecord(json) && Array.isArray(json.result)) {
      return json.result.filter((x) => typeof x === "string") as string[];
    }
    // Older builds might return just an array
    if (Array.isArray(json)) {
      return (json as unknown[]).filter((x) => typeof x === "string") as string[];
    }
    return [];
  }

  async listParticipants(token: string, alias: string): Promise<unknown> {
    const liveToken = this.currentToken() || token;
    const url = `${this.cfg.nodeUrl}/api/client/v2/conferences/${encodeURIComponent(
      alias
    )}/participants`;
    const headers = this.h({ token: liveToken });

    console.info("[agent-dial]", "participants -> GET", url);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`participants failed: ${res.status}`);
    return await res.json();
  }

  /** Best-effort "disconnect all" for the session + stop keepalive. */
  async disconnectAll(token: string, alias: string) {
    this.stopKeepAlive();
    const liveToken = this.currentToken() || token;

    try {
      const url = `${this.cfg.nodeUrl}/api/client/v2/conferences/${encodeURIComponent(
        alias
      )}/disconnect`;
      const res = await fetch(url, {
        method: "POST",
        headers: this.h({ token: liveToken }),
      });
      if (res.ok) return;
      // non-OK is tolerated here
    } catch {
      // ignore best-effort errors
    }
  }

  /** Release ONLY the initial API user client token (do NOT end the conference). Stops keepalive first. */
  async releaseToken(token: string, alias: string): Promise<void> {
    this.stopKeepAlive();
    const liveToken = this.currentToken() || token;

    const url = `${this.cfg.nodeUrl}/api/client/v2/conferences/${encodeURIComponent(
      alias
    )}/release_token`;

    try {
      const res = await fetch(url, { method: "POST", headers: this.h({ token: liveToken }) });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn("[agent-dial]", "release_token non-OK", res.status, body);
      } else {
        console.info("[agent-dial]", "release_token ok");
      }
    } catch (e) {
      console.warn("[agent-dial]", "release_token network error (ignored)", e);
    }
  }
}
