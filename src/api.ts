// ───────────────────────────────────────────────────────────────────────────────
// File: src/api.ts
// External Contacts (paged) with robust schema support + optional filters
// Logs are consistently tagged with "agent-dial".
// Label: "lastName, First Name" (fallbacks to displayName -> name -> org)
// Value: workPhone (preferred), else typed 'work' in phoneNumbers, else first usable
// Two-pass query: org-filter first, then fallback without org filter if empty.
// ───────────────────────────────────────────────────────────────────────────────

import platformClient from "purecloud-platform-client-v2";
import { MasterVariables } from "./masterVariables";
import { loginGenesys } from "./genesys";

export type DialOption = { label: string; value: string };

// ───────────────────────────────────────────────────────────────────────────────
// Type guards / shapes (support both modern and legacy EC schemas)
// ───────────────────────────────────────────────────────────────────────────────
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

type PhoneNumber = { display?: string; address?: string; type?: string | null };

// externalIds item (legacy-ish)
type ExternalIdRef = {
  id?: string;
  externalId?: string;
  sourceId?: string;
  source?: string;
  type?: string;
};

// external source reference (various arrays)
type ExternalSourceRef = { id?: string; sourceId?: string; name?: string };

// organization ref on the contact entity
type ExternalOrganizationRef = { id?: string; name?: string };

type ExternalContact = {
  // modern-ish
  id?: string;
  displayName?: string;
  phoneNumbers?: PhoneNumber[];

  // legacy / alternate fields
  firstName?: string;
  lastName?: string;
  name?: string;
  workPhone?: string | PhoneNumber | null;
  externalIds?: ExternalIdRef[];
  externalOrganization?: ExternalOrganizationRef;

  // other possible source arrays (tenant/version dependent)
  externalSources?: ExternalSourceRef[];
  externalDataSources?: ExternalSourceRef[];
  sources?: ExternalSourceRef[];

  // misc (not required)
  division?: unknown;
  createDate?: unknown;
  modifyDate?: unknown;
  type?: unknown;
  selfUri?: unknown;
};

type ExternalContactsPage = {
  entities?: ExternalContact[];
  pageCount?: number;
};

// ───────────────────────────────────────────────────────────────────────────────
// Guards
// ───────────────────────────────────────────────────────────────────────────────
function isPhoneNumber(v: unknown): v is PhoneNumber {
  return (
    isRecord(v) &&
    (v.display === undefined || typeof v.display === "string") &&
    (v.address === undefined || typeof v.address === "string") &&
    (v.type === undefined || typeof v.type === "string" || v.type === null)
  );
}

function isExternalIdRef(v: unknown): v is ExternalIdRef {
  return (
    isRecord(v) &&
    (v.id === undefined || typeof v.id === "string") &&
    (v.externalId === undefined || typeof v.externalId === "string") &&
    (v.sourceId === undefined || typeof v.sourceId === "string") &&
    (v.source === undefined || typeof v.source === "string") &&
    (v.type === undefined || typeof v.type === "string")
  );
}

function isExternalSourceRef(v: unknown): v is ExternalSourceRef {
  return (
    isRecord(v) &&
    (v.id === undefined || typeof v.id === "string") &&
    (v.sourceId === undefined || typeof v.sourceId === "string") &&
    (v.name === undefined || typeof v.name === "string")
  );
}

function isExternalOrganizationRef(v: unknown): v is ExternalOrganizationRef {
  return (
    isRecord(v) &&
    (v.id === undefined || typeof v.id === "string") &&
    (v.name === undefined || typeof v.name === "string")
  );
}

function isExternalContact(v: unknown): v is ExternalContact {
  if (!isRecord(v)) return false;

  const pn = (v as Record<string, unknown>).phoneNumbers;
  if (pn !== undefined && !(Array.isArray(pn) && pn.every(isPhoneNumber))) return false;

  const displayName = (v as Record<string, unknown>).displayName;
  if (displayName !== undefined && typeof displayName !== "string") return false;

  const firstName = (v as Record<string, unknown>).firstName;
  if (firstName !== undefined && typeof firstName !== "string") return false;

  const lastName = (v as Record<string, unknown>).lastName;
  if (lastName !== undefined && typeof lastName !== "string") return false;

  const name = (v as Record<string, unknown>).name;
  if (name !== undefined && typeof name !== "string") return false;

  const wp = (v as Record<string, unknown>).workPhone;
  if (
    wp !== undefined &&
    wp !== null &&
    !(
      typeof wp === "string" ||
      isPhoneNumber(wp) ||
      (isRecord(wp) &&
        (((wp as Record<string, unknown>).display === undefined ||
          typeof (wp as Record<string, unknown>).display === "string") &&
         ((wp as Record<string, unknown>).address === undefined ||
          typeof (wp as Record<string, unknown>).address === "string")))
    )
  ) {
    return false;
  }

  const exIds = (v as Record<string, unknown>).externalIds;
  if (exIds !== undefined && !(Array.isArray(exIds) && exIds.every(isExternalIdRef))) return false;

  const org = (v as Record<string, unknown>).externalOrganization;
  if (org !== undefined && !isExternalOrganizationRef(org)) return false;

  const arrays: Array<unknown> = [
    (v as Record<string, unknown>).externalSources,
    (v as Record<string, unknown>).externalDataSources,
    (v as Record<string, unknown>).sources,
  ].filter(Boolean as unknown as (x: unknown) => x is unknown[]);
  if (!arrays.every((arr) => Array.isArray(arr) && arr.every(isExternalSourceRef))) {
    return false;
  }

  return true;
}

function isExternalContactsPage(v: unknown): v is ExternalContactsPage {
  return (
    isRecord(v) &&
    (v.entities === undefined ||
      (Array.isArray(v.entities) && v.entities.every(isExternalContact))) &&
    (v.pageCount === undefined || typeof v.pageCount === "number")
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────
function lastCommaFirst(first?: string, last?: string): string | undefined {
  const f = (first || "").trim();
  const l = (last || "").trim();
  if (l && f) return `${l}, ${f}`;
  if (l) return l;
  if (f) return f;
  return undefined;
}

/** Label builder: prefer "lastName, First Name" then displayName -> name -> org name. */
function buildLabel(c: ExternalContact): string | undefined {
  const lf = lastCommaFirst(c.firstName, c.lastName);
  if (lf) return lf;
  if (c.displayName && c.displayName.trim()) return c.displayName.trim();
  if (c.name && c.name.trim()) return c.name.trim();
  if (c.externalOrganization?.name) return c.externalOrganization.name.trim();
  return undefined;
}

/** Prefer explicit `workPhone`; then typed 'work' in phoneNumbers; then first usable. */
function pickFromWorkPhone(workPhone: ExternalContact["workPhone"]): string | undefined {
  if (!workPhone) return undefined;
  if (typeof workPhone === "string") return workPhone.trim() || undefined;
  if (isPhoneNumber(workPhone)) return (workPhone.display ?? workPhone.address) || undefined;
  if (isRecord(workPhone)) {
    const val = (workPhone["display"] ?? workPhone["address"]) as unknown;
    return typeof val === "string" ? (val || undefined) : undefined;
  }
  return undefined;
}

function pickWorkFromPhoneNumbers(pns: PhoneNumber[] | undefined): string | undefined {
  if (!pns || pns.length === 0) return undefined;
  const typed = pns.find((p) => typeof p.type === "string" && p.type.toLowerCase() === "work");
  if (typed?.display || typed?.address) return (typed.display ?? typed.address) as string;

  const hint = pns.find((p) => typeof p.display === "string" && /^work[:\s]/i.test(p.display));
  if (hint?.display) {
    const m = hint.display.match(/work[:\s-]*([^\s]+)/i);
    return m?.[1] ?? hint.display;
  }
  const first = pns.find((p) => p.display ?? p.address);
  return first ? ((first.display ?? first.address) as string) : undefined;
}

/** Determine if contact references a given External Source ID (any array flavor). */
function matchesExternalSource(c: ExternalContact, sourceId: string): boolean {
  if (!sourceId || sourceId.trim().length === 0) return true;
  const sid = sourceId.trim();

  if (Array.isArray(c.externalIds)) {
    for (const e of c.externalIds) {
      if (!e) continue;
      if (e.sourceId === sid || e.source === sid || e.id === sid) return true;
    }
  }
  const sourceArrays: (ExternalSourceRef[] | undefined)[] = [
    c.externalSources,
    c.externalDataSources,
    c.sources,
  ];
  for (const arr of sourceArrays) {
    if (!arr || arr.length === 0) continue;
    for (const s of arr) {
      if (!s) continue;
      if (s.id === sid || s.sourceId === sid) return true;
    }
  }
  return false;
}

/** Optional filter by Organization Name (exact, case-insensitive). */
function matchesOrganizationName(c: ExternalContact, orgName: string): boolean {
  if (!orgName || !orgName.trim()) return true;
  const want = orgName.trim().toLowerCase();
  const got = c.externalOrganization?.name?.trim().toLowerCase();
  return got ? got === want : false;
}

/** Sort + dedupe for stable UI. */
function dedupeAndSort(list: DialOption[]): DialOption[] {
  const seen = new Set<string>();
  const out: DialOption[] = [];
  for (const o of list) {
    const key = `${o.label}||${o.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(o);
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// External Contacts fetch (two-pass: with org filter, then fallback without)
// ───────────────────────────────────────────────────────────────────────────────
async function fetchFromExternalContacts(): Promise<DialOption[]> {
  await loginGenesys();

  const ec = new platformClient.ExternalContactsApi();
  const pageSize = 100;

  // Source filter (opt-in)
  const applySourceFilter = Boolean(MasterVariables.genesys.applySourceFilter);
  const filterSourceId = applySourceFilter
    ? String(MasterVariables.genesys.externalSourceId || "").trim()
    : "";

  // Organization filter (pass 1)
  const useOrgFilterInitial = Boolean(MasterVariables.genesys.filterExternalContacts);
  const orgName = String(MasterVariables.genesys.externalOrganizationName || "").trim();

  async function gather(useOrgFilter: boolean): Promise<DialOption[]> {
    let page = 1;
    const options: DialOption[] = [];

    // diagnostics
    let total = 0, kept = 0, skippedLabel = 0, skippedValue = 0, skippedOrg = 0, skippedSource = 0;

    for (let i = 0; i < 50; i++) {
      const pageDataUnknown = await (ec as unknown as {
        getExternalcontactsContacts: (p?: { pageNumber?: number; pageSize?: number }) => Promise<unknown>;
      }).getExternalcontactsContacts({ pageNumber: page, pageSize });

      if (!isExternalContactsPage(pageDataUnknown)) {
        console.warn("[agent-dial]", "external-contacts: unexpected page shape", pageDataUnknown);
        break;
      }

      const entities = pageDataUnknown.entities ?? [];
      const pageCount = pageDataUnknown.pageCount ?? 1;

      console.info("[agent-dial]", "external-contacts page", {
        page,
        pageCount,
        entities: entities.length,
        sampleKeys: entities[0] ? Object.keys(entities[0]).sort() : [],
        sourceFilter: applySourceFilter ? filterSourceId : "(disabled)",
        orgFilter: useOrgFilter ? (orgName || "(empty)") : "(disabled)",
      });

      if (entities.length === 0) break;

      for (const c of entities) {
        total++;

        if (filterSourceId && !matchesExternalSource(c, filterSourceId)) { skippedSource++; continue; }
        if (useOrgFilter && !matchesOrganizationName(c, orgName)) { skippedOrg++; continue; }

        const label = buildLabel(c);

        const fromWorkPhone = pickFromWorkPhone(c.workPhone);
        const fromNumbersPreferred = pickWorkFromPhoneNumbers(c.phoneNumbers);
        const value = (fromWorkPhone || fromNumbersPreferred || "").trim();

        if (!label) { skippedLabel++; continue; }
        if (!value) { skippedValue++; continue; }

        options.push({ label, value });
        kept++;
      }

      if (page >= pageCount) break;
      page++;
    }

    console.info("[agent-dial]", "external-contacts summary", {
      total, kept, skippedLabel, skippedValue, skippedOrg, skippedSource,
      orgFilterApplied: useOrgFilter, orgName: useOrgFilter ? orgName || "(empty)" : undefined
    });
    console.info("[agent-dial]", "external-contacts options", { count: options.length });

    return options;
  }

  // Pass 1: org filter (if enabled)
  const pass1 = await gather(useOrgFilterInitial);
  if (pass1.length > 0 || !useOrgFilterInitial) {
    return dedupeAndSort(pass1);
  }

  // Pass 2: fallback without org filter
  console.warn("[agent-dial]", "org filter returned 0 results — retrying without org filter");
  const pass2 = await gather(false);
  return dedupeAndSort(pass2);
}

// ───────────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────────
export async function fetchRegisteredEndpoints(): Promise<DialOption[]> {
  try {
    const fromEC = await fetchFromExternalContacts();
    if (fromEC.length > 0) return fromEC;
  } catch (err) {
    console.warn("[agent-dial]", "external contacts fetch failed -> fallback to static", err);
  }

  const statics = Array.isArray(MasterVariables.staticDialAliases)
    ? MasterVariables.staticDialAliases
    : [];
  const fallback = statics.map((s) => ({ label: s, value: s }));
  console.info("[agent-dial]", "using static options (count=%d)", fallback.length);
  return dedupeAndSort(fallback);
}
