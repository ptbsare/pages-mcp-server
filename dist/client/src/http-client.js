/**
 * HTTP MCP Client — connects to a remote /mcp endpoint.
 * Implements the MCP client side over HTTP JSON-RPC.
 */
import path from "path";
import fs from "fs";
export class PagesMcpHttpClient {
    baseUrl;
    authToken;
    initialized = false;
    constructor(baseUrl, authToken) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.authToken = authToken;
    }
    async rpcCall(method, params) {
        const res = await fetch(`${this.baseUrl}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.authToken}`,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now().toString(),
                method,
                params,
            }),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }
        const data = await res.json();
        if (data.error) {
            throw new Error(`MCP Error: ${data.error.message}`);
        }
        return data.result;
    }
    async initialize() {
        if (this.initialized)
            return;
        await this.rpcCall("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "pages-mcp-http-client", version: "1.0.0" },
        });
        this.initialized = true;
    }
    async listTools() {
        await this.initialize();
        const result = await this.rpcCall("tools/list");
        return result.tools || [];
    }
    async deployHtml(value, name, description) {
        await this.initialize();
        const result = await this.rpcCall("tools/call", {
            name: "deploy_html",
            arguments: { value, name, description },
        });
        return result.content?.[0]?.text || "No response";
    }
    async deployFolder(localPath, name, description) {
        // Validate local path (SSRF prevention)
        this.validateLocalPath(localPath);
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
            throw new Error(`Folder not found: ${localPath}`);
        }
        // Zip the folder locally and upload via REST API
        const AdmZip = (await import("adm-zip")).default;
        const zip = new AdmZip();
        const addDir = (dir, zipPath) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const sp = path.join(dir, e.name);
                if (fs.lstatSync(sp).isSymbolicLink())
                    continue;
                if (e.isDirectory())
                    addDir(sp, zipPath + e.name + "/");
                else {
                    zip.addFile(zipPath + e.name, fs.readFileSync(sp));
                }
            }
        };
        addDir(localPath, "");
        const zipBuffer = zip.toBuffer();
        const zipName = (name || path.basename(localPath)) + ".zip";
        // deploy_folder uses /api/deploy/folder which returns /s/:shareId (static web page)
        const zipBase64 = zipBuffer.toString("base64");
        const resp = await fetch(`${this.baseUrl}/api/deploy/folder`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.authToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ zipBase64, name, description }),
        });
        if (!resp.ok)
            throw new Error(`Upload failed: ${await resp.text()}`);
        const data = await resp.json();
        return `✅ Folder deployed!\n\nURL: ${data.url}\nID: ${data.id}\nShare ID: ${data.shareId}\nFiles: ${data.fileCount}\nSize: ${data.totalSize} bytes`;
    }
    async listPages(limit, offset) {
        await this.initialize();
        const result = await this.rpcCall("tools/call", {
            name: "list_pages",
            arguments: { limit, offset },
        });
        return result.content?.[0]?.text || "No response";
    }
    async deletePage(id) {
        await this.initialize();
        const result = await this.rpcCall("tools/call", {
            name: "delete_page",
            arguments: { id },
        });
        return result.content?.[0]?.text || "No response";
    }
    /**
     * Validate local path before uploading.
     * Environment variables:
     *   DEPLOY_ALLOW_PATHS — comma-separated list of allowed path prefixes (e.g. "/home/user/projects,/tmp")
     *   DEPLOY_BLOCK_PATHS — comma-separated list of blocked path prefixes (default: /etc,/root,/home,/var,/usr,/proc,/sys,/dev,/boot,/bin,/sbin,/lib,/lib64)
     *   DEPLOY_ALLOW_ALL — set to "1" to disable all path restrictions
     */
    validateLocalPath(localPath) {
        if (process.env.DEPLOY_ALLOW_ALL === "1")
            return;
        const resolved = path.resolve(localPath);
        const allowPaths = (process.env.DEPLOY_ALLOW_PATHS || "").split(",").map(p => p.trim()).filter(Boolean);
        if (allowPaths.length > 0) {
            const allowed = allowPaths.some(prefix => resolved.startsWith(path.resolve(prefix) + "/") || resolved === path.resolve(prefix));
            if (!allowed)
                throw new Error(`Path not allowed: ${localPath}. Allowed prefixes: ${allowPaths.join(", ")}`);
            return;
        }
        const defaultBlocked = ["/etc", "/root", "/home", "/var", "/usr", "/proc", "/sys", "/dev", "/boot", "/bin", "/sbin", "/lib", "/lib64"];
        const blockPaths = (process.env.DEPLOY_BLOCK_PATHS || defaultBlocked.join(",")).split(",").map(p => p.trim()).filter(Boolean);
        for (const prefix of blockPaths) {
            const resolvedPrefix = path.resolve(prefix);
            if (resolved.startsWith(resolvedPrefix + "/") || resolved === resolvedPrefix) {
                throw new Error(`Access denied: path '${localPath}' is in blocked directory '${prefix}'`);
            }
        }
    }
    /**
     * Deploy a local file or folder to the remote server.
     * Reads the file/folder locally, uploads via REST API.
     */
    async deployFile(localPath, name, description) {
        if (!fs.existsSync(localPath)) {
            throw new Error(`Path not found: ${localPath}`);
        }
        // Validate local path (SSRF prevention)
        this.validateLocalPath(localPath);
        const stat = fs.statSync(localPath);
        if (stat.isFile()) {
            // Single file: read and upload
            const fileName = path.basename(localPath);
            const content = fs.readFileSync(localPath);
            const resp = await fetch(`${this.baseUrl}/api/deploy/file?filename=${encodeURIComponent(fileName)}&name=${encodeURIComponent(name || "")}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${this.authToken}`, "Content-Type": "application/octet-stream" },
                body: content,
            });
            if (!resp.ok)
                throw new Error(`Upload failed: ${resp.status}`);
            const data = await resp.json();
            return `✅ File shared!\n\nDirect download: ${data.url}\nFile: ${data.fileName}\nSize: ${data.fileSize} bytes`;
        }
        else if (stat.isDirectory()) {
            // Folder: zip and upload
            const AdmZip = (await import("adm-zip")).default;
            const zip = new AdmZip();
            const addDir = (dir, zipPath) => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const sp = path.join(dir, e.name);
                    if (fs.lstatSync(sp).isSymbolicLink())
                        continue;
                    if (e.isDirectory())
                        addDir(sp, zipPath + e.name + "/");
                    else {
                        const content = fs.readFileSync(sp);
                        zip.addFile(zipPath + e.name, content);
                    }
                }
            };
            addDir(localPath, "");
            const zipBuffer = zip.toBuffer();
            const zipName = (name || path.basename(localPath)) + ".zip";
            const resp = await fetch(`${this.baseUrl}/api/deploy/file?filename=${encodeURIComponent(zipName)}&name=${encodeURIComponent(name || "")}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${this.authToken}`, "Content-Type": "application/octet-stream" },
                body: zipBuffer,
            });
            if (!resp.ok)
                throw new Error(`Upload failed: ${resp.status}`);
            const data = await resp.json();
            return `✅ Folder shared!\n\nShare page: ${data.url}\nFiles: ${data.fileCount}\nTotal size: ${data.totalSize} bytes`;
        }
        throw new Error("Path is neither a file nor a directory");
    }
}
//# sourceMappingURL=http-client.js.map