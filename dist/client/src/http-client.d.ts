/**
 * HTTP MCP Client — connects to a remote /mcp endpoint.
 * Implements the MCP client side over HTTP JSON-RPC.
 */
export declare class PagesMcpHttpClient {
    private baseUrl;
    private authToken;
    private initialized;
    constructor(baseUrl: string, authToken: string);
    private rpcCall;
    initialize(): Promise<void>;
    listTools(): Promise<any[]>;
    deployHtml(value: string, name?: string, description?: string): Promise<string>;
    deployFolder(path: string, name?: string, description?: string): Promise<string>;
    listPages(limit?: number, offset?: number): Promise<string>;
    deletePage(id: string): Promise<string>;
    /**
     * Deploy a local file or folder to the remote server.
     * Reads the file/folder locally, uploads via REST API.
     */
    deployFile(localPath: string, name?: string, description?: string): Promise<string>;
}
//# sourceMappingURL=http-client.d.ts.map