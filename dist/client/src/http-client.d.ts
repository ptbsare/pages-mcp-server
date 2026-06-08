export declare class PagesMcpHttpClient {
    private baseUrl;
    private authToken;
    private initialized;
    constructor(baseUrl: string, authToken: string);
    private rpcCall;
    initialize(): Promise<void>;
    listTools(): Promise<any[]>;
    /** Deploy a single HTML file as a website. Returns a public URL. */
    deployHtml(valueOrPath?: string, name?: string, description?: string, isPath?: boolean): Promise<string>;
    /** Deploy a local folder as a static website. Must contain index.html. Returns a public URL. */
    deployFolder(localPath: string, name?: string, description?: string): Promise<string>;
    listPages(limit?: number, offset?: number): Promise<string>;
    deletePage(id: string): Promise<string>;
    /**
     * Validate local path before uploading.
     * Environment variables:
     *   DEPLOY_ALLOW_PATHS — comma-separated list of allowed path prefixes (e.g. "/home/user/projects,/tmp")
     *   DEPLOY_BLOCK_PATHS — comma-separated list of blocked path prefixes (default: /etc,/var,/usr,/proc,/sys,/dev,/boot,/bin,/sbin,/lib,/lib64)
     *   DEPLOY_BLOCK_ROOT_DIRS — comma-separated list of blocked dirs under /root (default: /root/.ssh,/root/.gnupg,/root/.aws,/root/.docker,/root/.kube,/root/.config,/root/.local,/root/.npmrc,/root/.netrc)
     *   DEPLOY_ALLOW_ALL — set to "1" to disable all path restrictions
     */
    private validateLocalPath;
    /**
     * Deploy a local file or folder to the remote server.
     * Reads the file/folder locally, uploads via REST API.
     */
    /** Share a local file or folder for file sharing (NOT for website deployment). */
    deployFile(localPath: string, name?: string, description?: string): Promise<string>;
}
//# sourceMappingURL=http-client.d.ts.map