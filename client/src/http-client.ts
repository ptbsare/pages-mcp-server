/**
 * HTTP MCP Client — connects to a remote /mcp endpoint.
 * Implements the MCP client side over HTTP JSON-RPC.
 */

export class PagesMcpHttpClient {
  private baseUrl: string;
  private authToken: string;
  private initialized = false;

  constructor(baseUrl: string, authToken: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authToken = authToken;
  }

  private async rpcCall(method: string, params?: any): Promise<any> {
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

    const data: any = await res.json();
    if (data.error) {
      throw new Error(`MCP Error: ${data.error.message}`);
    }
    return data.result;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpcCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pages-mcp-http-client", version: "1.0.0" },
    });
    this.initialized = true;
  }

  async listTools(): Promise<any[]> {
    await this.initialize();
    const result = await this.rpcCall("tools/list");
    return result.tools || [];
  }

  async deployHtml(value: string, name?: string, description?: string): Promise<string> {
    await this.initialize();
    const result = await this.rpcCall("tools/call", {
      name: "deploy_html",
      arguments: { value, name, description },
    });
    return result.content?.[0]?.text || "No response";
  }

  async deployFolder(path: string, name?: string, description?: string): Promise<string> {
    await this.initialize();
    const result = await this.rpcCall("tools/call", {
      name: "deploy_folder",
      arguments: { path, name, description },
    });
    return result.content?.[0]?.text || "No response";
  }

  async listPages(limit?: number, offset?: number): Promise<string> {
    await this.initialize();
    const result = await this.rpcCall("tools/call", {
      name: "list_pages",
      arguments: { limit, offset },
    });
    return result.content?.[0]?.text || "No response";
  }

  async deletePage(id: string): Promise<string> {
    await this.initialize();
    const result = await this.rpcCall("tools/call", {
      name: "delete_page",
      arguments: { id },
    });
    return result.content?.[0]?.text || "No response";
  }

  /**
   * Deploy a local file or folder to the remote server.
   * Reads the file/folder locally, uploads via REST API.
   */
  async deployFile(localPath: string, name?: string, description?: string): Promise<string> {
    const fs = await import("fs");
    const path = await import("path");
    if (!fs.existsSync(localPath)) {
      throw new Error(`Path not found: ${localPath}`);
    }
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
      if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
      const data: any = await resp.json();
      return `✅ File shared!\n\nDirect download: ${data.url}\nFile: ${data.fileName}\nSize: ${data.fileSize} bytes`;
    } else if (stat.isDirectory()) {
      // Folder: zip and upload
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip();
      const addDir = (dir: string, zipPath: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const sp = path.join(dir, e.name);
          if (fs.lstatSync(sp).isSymbolicLink()) continue;
          if (e.isDirectory()) addDir(sp, zipPath + e.name + "/");
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
      if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
      const data: any = await resp.json();
      return `✅ Folder shared!\n\nShare page: ${data.url}\nFiles: ${data.fileCount}\nTotal size: ${data.totalSize} bytes`;
    }
    throw new Error("Path is neither a file nor a directory");
  }
}
