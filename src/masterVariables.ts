// ───────────────────────────────────────────────────────────────────────────────
// File: masterVariables.ts
// ───────────────────────────────────────────────────────────────────────────────

export const MasterVariables = {
  // Pexip API (Client/Conference Node) used to initiate sessions and make API calls
  pexip: {
    nodeUrl: import.meta.env.VITE_PEXIP_NODE_URL || "https://your-pexip-node.example.com",
  },

  // where the conference dials first (SIP, audio-only)
  dialPlan: {
    contactCenterAlias: import.meta.env.VITE_CONTACT_CENTER_ALIAS || "+1234567890@example.cloud",
    role: "HOST" as const,
    protocol: "sip" as const,
    callType: "audio" as const,
  },

  // Genesys Cloud environment where the widget is hosted
  genesys: {
    cloudRegion: import.meta.env.VITE_GENESYS_REGION || "usw2.pure.cloud",
    clientId: import.meta.env.VITE_GENESYS_CLIENT_ID || "your-client-id-here",

    // External Contacts filters
    filterExternalContacts: import.meta.env.VITE_FILTER_EXTERNAL_CONTACTS === "true" || true,
    externalOrganizationName: import.meta.env.VITE_EXTERNAL_ORG_NAME || "Your Organization Name",

    // Optional source filter (off by default)
    applySourceFilter: import.meta.env.VITE_APPLY_SOURCE_FILTER === "true" || false,
    externalSourceId: import.meta.env.VITE_EXTERNAL_SOURCE_ID || "",

    // (Outbound contact list -- may not be used)
    outboundContactListId: import.meta.env.VITE_OUTBOUND_CONTACT_LIST_ID || undefined,
    outboundWorkColumn: import.meta.env.VITE_OUTBOUND_WORK_COLUMN || "WORK",
    outboundNameColumn: import.meta.env.VITE_OUTBOUND_NAME_COLUMN || "NAME",
  },

  // OPTIONAL: manual static fallback choices
  staticDialAliases: [
    // "room-01@example.com",
  ],

  ui: {
    brand: {
      accent: import.meta.env.VITE_BRAND_ACCENT || "#FF4F1F",
      bg: import.meta.env.VITE_BRAND_BG || "#0B0B0D",
      fg: import.meta.env.VITE_BRAND_FG || "#F4F6F8",
      muted: import.meta.env.VITE_BRAND_MUTED || "#9AA0A6",
      card: import.meta.env.VITE_BRAND_CARD || "#141518",
      ring: import.meta.env.VITE_BRAND_RING || "#2A2D33",
      textPrimary: import.meta.env.VITE_BRAND_TEXT_PRIMARY || "#F4F6F8",
      textSecondary: import.meta.env.VITE_BRAND_TEXT_SECONDARY || "#9AA0A6",
      textOnAccent: import.meta.env.VITE_BRAND_TEXT_ON_ACCENT || "#0B0B0D",
      errorText: import.meta.env.VITE_BRAND_ERROR_TEXT || "#FFB3A6",
    },
    // simple feature toggles for visibility of form sections
    toggles: {
      showPexipServer: import.meta.env.VITE_SHOW_PEXIP_SERVER === "true" || false,
      showManualAlias: import.meta.env.VITE_SHOW_MANUAL_ALIAS === "true" || true,
      showSessionAlias: import.meta.env.VITE_SHOW_SESSION_ALIAS === "true" || false,
    },
    /** Display name used for the External Device (Leg 3) dial-out */
    externalDeviceDisplayName: import.meta.env.VITE_EXTERNAL_DEVICE_NAME || "Genesys Widget",
  },

  // name of the hosting folder for the compiled app
  basePath: import.meta.env.VITE_BASE_PATH || "/",

  conference: {
    aliasPrefix: import.meta.env.VITE_CONFERENCE_ALIAS_PREFIX || "genesys-pex-",
    randomAlias: () => `${import.meta.env.VITE_CONFERENCE_ALIAS_PREFIX || "genesys-pex-"}${Math.random().toString(36).slice(2, 8)}`,
    pin: import.meta.env.VITE_CONFERENCE_PIN || "",
  },
};
