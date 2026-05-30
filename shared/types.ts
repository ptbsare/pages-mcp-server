// ============================================================
// Shared types between server and client
// ============================================================

/** A deployed page record stored in the database */
export interface DeployedPage {
  id: string;           // nanoid
  name: string;         // human-readable name
  description?: string;
  createdAt: string;    // ISO date
  updatedAt: string;    // ISO date
  fileCount: number;
  /** The URL-safe share path, e.g. "hdhdjsjhsguh" */
  shareId: string;
}

/** Request to deploy HTML content (single file) */
export interface DeployHtmlRequest {
  value: string;        // full HTML content
  name?: string;        // optional name
  description?: string;
}

/** Request to deploy a folder (multi-file) */
export interface DeployFolderRequest {
  /** Base64-encoded zip archive of the folder */
  zipBase64: string;
  name?: string;
  description?: string;
}

/** Response after a successful deployment */
export interface DeployResponse {
  id: string;
  shareId: string;
  url: string;          // full public URL, e.g. https://domain.com/s/hdhdjsjhsguh
  name: string;
  createdAt: string;
}

/** Admin credentials */
export interface AdminCredentials {
  username: string;
  password: string;
}

/** Server configuration */
export interface ServerConfig {
  /** Port to listen on */
  port: number;
  /** Base domain, e.g. "https://mysite.com" or "https://mysite.com:38300" */
  domain: string;
  /** Admin username */
  adminUsername: string;
  /** Admin password */
  adminPassword: string;
  /** Bearer token for MCP / deploy API auth */
  authToken: string;
  /** Path to SQLite DB file */
  dbPath: string;
  /** Path to uploaded files storage */
  storagePath: string;
}

/** Build a public URL with port if non-standard */
export function buildUrl(domain: string, port: number): string {
  try {
    const url = new URL(domain);
    const isDefaultPort = (url.protocol === "https:" && port === 443) || (url.protocol === "http:" && port === 80);
    if (!isDefaultPort && !url.port) {
      url.port = String(port);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return domain;
  }
}

/** MCP tool: deploy_html input */
export interface DeployHtmlInput {
  value: string;
  name?: string;
  description?: string;
}

/** MCP tool: deploy_folder input */
export interface DeployFolderInput {
  /** Absolute local path to the folder to deploy */
  path: string;
  name?: string;
  description?: string;
}

/** List pages response */
export interface ListPagesResponse {
  pages: DeployedPage[];
  total: number;
}

/** An API auth token */
export interface AuthToken {
  id: string;
  token: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** Error response */
export interface ErrorResponse {
  error: string;
  message?: string;
}
