/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Pexip Configuration
  readonly VITE_PEXIP_NODE_URL: string;
  
  // Dial Plan Configuration
  readonly VITE_CONTACT_CENTER_ALIAS: string;
  
  // Genesys Cloud Configuration
  readonly VITE_GENESYS_REGION: string;
  readonly VITE_GENESYS_CLIENT_ID: string;
  readonly VITE_FILTER_EXTERNAL_CONTACTS: string;
  readonly VITE_EXTERNAL_ORG_NAME: string;
  readonly VITE_APPLY_SOURCE_FILTER: string;
  readonly VITE_EXTERNAL_SOURCE_ID: string;
  readonly VITE_OUTBOUND_CONTACT_LIST_ID: string;
  readonly VITE_OUTBOUND_WORK_COLUMN: string;
  readonly VITE_OUTBOUND_NAME_COLUMN: string;
  
  // UI Branding
  readonly VITE_BRAND_ACCENT: string;
  readonly VITE_BRAND_BG: string;
  readonly VITE_BRAND_FG: string;
  readonly VITE_BRAND_MUTED: string;
  readonly VITE_BRAND_CARD: string;
  readonly VITE_BRAND_RING: string;
  readonly VITE_BRAND_TEXT_PRIMARY: string;
  readonly VITE_BRAND_TEXT_SECONDARY: string;
  readonly VITE_BRAND_TEXT_ON_ACCENT: string;
  readonly VITE_BRAND_ERROR_TEXT: string;
  
  // UI Toggles
  readonly VITE_SHOW_PEXIP_SERVER: string;
  readonly VITE_SHOW_MANUAL_ALIAS: string;
  readonly VITE_SHOW_SESSION_ALIAS: string;
  readonly VITE_EXTERNAL_DEVICE_NAME: string;
  
  // Application Configuration
  readonly VITE_BASE_PATH: string;
  readonly VITE_CONFERENCE_ALIAS_PREFIX: string;
  readonly VITE_CONFERENCE_PIN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
