/** A deployed page record stored in the database */
export interface DeployedPage {
    id: string;
    name: string;
    description?: string;
    type?: string;
    createdAt: string;
    updatedAt: string;
    fileCount: number;
    totalSize?: number;
    /** The URL-safe share path, e.g. "hdhdjsjhsguh" */
    shareId: string;
    locked?: boolean;
}
/** Request to deploy HTML content (single file) */
export interface DeployHtmlRequest {
    value: string;
    name?: string;
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
    url: string;
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
    /** Port to listen on (internal) */
    port: number;
    /** External port for public URLs (defaults to port). Set via OUT_PORT env var.
     *  Docker port mapping: container 3000 → host 38300, set OUT_PORT=38300 */
    outPort: number;
    /** Base domain without port, e.g. "https://mysite.com" */
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
/** Build a public URL with external port if non-standard */
export declare function buildUrl(domain: string, outPort: number): string;
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
//# sourceMappingURL=types.d.ts.map