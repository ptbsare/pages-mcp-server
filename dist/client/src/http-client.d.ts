export declare class PagesMcpHttpClient {
    private baseUrl;
    private authToken;
    private initialized;
    constructor(baseUrl: string, authToken: string);
    private rpcCall;
    initialize(): Promise<void>;
    listTools(): Promise<any[]>;
    deployHtml(value: string, name?: string, description?: string): Promise<string>;
    deployFolder(localPath: string, name?: string, description?: string): Promise<string>;
    listPages(limit?: number, offset?: number): Promise<string>;
    deletePage(id: string): Promise<string>;
    /**
     * Validate local path before uploading.
     * Environment variables:
     *   DEPLOY_ALLOW_PATHS — comma-separated list of allowed path prefixes (e.g. "/home/user/projects,/tmp")
     *   DEPLOY_BLOCK_PATHS — comma-separated list of blocked path prefixes (default: /etc,/root,/home,/var,/usr,/proc,/sys,/dev,/boot,/bin,/sbin,/lib,/lib64)
     *   DEPLOY_ALLOW_ALL — set to "1" to disable all path restrictions
     */
    private validateLocalPath;
    /**
     * Deploy a local file or folder to the remote server.
     * Reads the file/folder locally, uploads via REST API.
     */
    deployFile(localPath: string, name?: string, description?: string): Promise<string>;
}
//# sourceMappingURL=http-client.d.ts.map