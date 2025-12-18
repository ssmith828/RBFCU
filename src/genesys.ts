// ───────────────────────────────────────────────────────────────────────────────
// File: src/genesys.ts  (strict typing, no 'any')
// ───────────────────────────────────────────────────────────────────────────────

import platformClient from "purecloud-platform-client-v2";
import { MasterVariables } from "./masterVariables";

const client = platformClient.ApiClient.instance;

// Persist tokens/settings across reloads (namespaced)
client.setPersistSettings(true, "agent-dialer-widget");

/** Build an OAuth redirect URI that matches the hosting URL Genesys loads. */
function getRedirectUri(): string {
  const u = new URL(window.location.href);
  u.hash = "";
  u.search = "";
  if (!u.pathname.endsWith("index.html")) {
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    u.pathname += "index.html";
  }
  return u.toString();
}

type MaybeTokenClient = { getAuthToken?: () => string | null | undefined };
function hasAuthToken(c: unknown): boolean {
  const maybe = c as MaybeTokenClient;
  const token = typeof maybe.getAuthToken === "function" ? maybe.getAuthToken() : undefined;
  return typeof token === "string" && token.length > 0;
}

/** Log in via implicit grant (no-op if already authenticated). */
export async function loginGenesys(): Promise<void> {
  client.setEnvironment(MasterVariables.genesys.cloudRegion);
  await client.loginImplicitGrant(MasterVariables.genesys.clientId, getRedirectUri());
}

/** Returns the current user's ID (UUID). */
export async function getCurrentUserId(): Promise<string> {
  if (!hasAuthToken(client)) {
    await loginGenesys();
  }
  const usersApi = new platformClient.UsersApi();
  const me = await usersApi.getUsersMe();
  if (!me?.id) throw new Error("Could not determine current user ID.");
  return String(me.id);
}

/** Queue record for UI. */
export type AgentQueue = {
  id: string;
  name: string;
  joined?: boolean;
};

// Shapes for RoutingApi.getRoutingQueuesMe
type RoutingQueuesMeParams = {
  pageSize?: number;
  pageNumber?: number;
  joined?: boolean;
};
type RoutingQueueMeEntity = {
  id?: string;
  name?: string;
  joined?: boolean;
};
type RoutingQueuesMeResponse = {
  entities?: RoutingQueueMeEntity[];
  pageCount?: number;
};

// Shapes for UsersApi.getUserQueues (fallback)
type UsersApiQueueEntityShapeA = { id?: string; name?: string };
type UsersApiQueueEntityShapeB = { queue?: { id?: string; name?: string } };
type UserQueuesResponse = {
  entities?: Array<UsersApiQueueEntityShapeA | UsersApiQueueEntityShapeB>;
  pageCount?: number;
};

// type helpers
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function getString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function getBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function isRoutingQueuesMeResponse(u: unknown): u is RoutingQueuesMeResponse {
  if (!isRecord(u)) return false;
  const { entities, pageCount } = u as RoutingQueuesMeResponse;
  if (entities !== undefined && !Array.isArray(entities)) return false;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (!isRecord(e)) return false;
      const id = (e as RoutingQueueMeEntity).id;
      const name = (e as RoutingQueueMeEntity).name;
      const joined = (e as RoutingQueueMeEntity).joined;
      if (id !== undefined && typeof id !== "string") return false;
      if (name !== undefined && typeof name !== "string") return false;
      if (joined !== undefined && typeof joined !== "boolean") return false;
    }
  }
  if (pageCount !== undefined && typeof pageCount !== "number") return false;
  return true;
}
function isUserQueuesResponse(u: unknown): u is UserQueuesResponse {
  if (!isRecord(u)) return false;
  const { entities, pageCount } = u as UserQueuesResponse;
  if (entities !== undefined && !Array.isArray(entities)) return false;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (!isRecord(e)) return false;
      if ("queue" in e) {
        const q = (e as UsersApiQueueEntityShapeB).queue;
        if (q && isRecord(q)) {
          if (q.id !== undefined && typeof q.id !== "string") return false;
          if (q.name !== undefined && typeof q.name !== "string") return false;
        }
      } else {
        const q = e as UsersApiQueueEntityShapeA;
        if (q.id !== undefined && typeof q.id !== "string") return false;
        if (q.name !== undefined && typeof q.name !== "string") return false;
      }
    }
  }
  if (pageCount !== undefined && typeof pageCount !== "number") return false;
  return true;
}
function normalizeUsersApiEntityToQueue(e: unknown): AgentQueue | null {
  if (!isRecord(e)) return null;
  if ("queue" in e) {
    const q = (e as UsersApiQueueEntityShapeB).queue;
    if (q && isRecord(q)) {
      const id = getString(q.id);
      const name = getString(q.name);
      if (id && name) return { id, name };
    }
  } else {
    const q = e as UsersApiQueueEntityShapeA;
    const id = getString(q.id);
    const name = getString(q.name);
    if (id && name) return { id, name };
  }
  return null;
}

/**
 * Returns queues for the signed-in user.
 * Prefers RoutingApi.getRoutingQueuesMe; falls back to UsersApi.getUserQueues.
 * Result is sorted: joined first, then by name.
 */
export async function listMyQueues(): Promise<AgentQueue[]> {
  if (!hasAuthToken(client)) {
    await loginGenesys();
  }

  // Preferred: RoutingApi.getRoutingQueuesMe
  const routingApi = new platformClient.RoutingApi();
  const routingShim = routingApi as unknown as {
    getRoutingQueuesMe: (params?: RoutingQueuesMeParams) => Promise<unknown>;
  };

  const out: AgentQueue[] = [];
  const pageSize = 100;
  let pageNumber = 1;

  try {
    for (let i = 0; i < 50; i++) {
      const raw = await routingShim.getRoutingQueuesMe({ pageSize, pageNumber });
      if (!isRoutingQueuesMeResponse(raw)) break;

      const entities = raw.entities ?? [];
      if (entities.length === 0) break;

      for (const q of entities) {
        const id = getString(q.id);
        const name = getString(q.name);
        const joined = getBoolean(q.joined);
        if (id && name) out.push({ id, name, joined });
      }

      const pageCount = typeof raw.pageCount === "number" ? raw.pageCount : 1;
      if (pageNumber >= pageCount) break;
      pageNumber++;
    }

    if (out.length > 0) {
      out.sort(
        (a, b) =>
          (Number(Boolean(b.joined)) - Number(Boolean(a.joined))) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
      return out;
    }
  } catch {
    // fall through to UsersApi fallback
  }

  // Fallback: UsersApi.getUserQueues
  const usersApi = new platformClient.UsersApi();
  const me = await usersApi.getUsersMe();
  const userId = me?.id ? String(me.id) : undefined;
  if (!userId) return out;

  const usersShim = usersApi as unknown as {
    getUserQueues: (id: string, params?: { pageNumber?: number; pageSize?: number }) => Promise<unknown>;
  };

  pageNumber = 1;
  for (let i = 0; i < 50; i++) {
    const raw = await usersShim.getUserQueues(userId, { pageNumber, pageSize });
    if (!isUserQueuesResponse(raw)) break;

    const entities = raw.entities ?? [];
    if (entities.length === 0) break;

    for (const e of entities) {
      const q = normalizeUsersApiEntityToQueue(e);
      if (q) out.push(q);
    }

    const pageCount = typeof raw.pageCount === "number" ? raw.pageCount : 1;
    if (pageNumber >= pageCount) break;
    pageNumber++;
  }

  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}
