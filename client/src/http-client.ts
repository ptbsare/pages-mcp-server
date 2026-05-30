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
}
