export declare class FileStorage {
    private basePath;
    constructor(storagePath: string);
    /** Get the directory path for a given shareId */
    private getPageDir;
    /** Store a single HTML file as index.html for a page */
    storeHtml(shareId: string, html: string): string;
    /** Extract a base64-encoded zip archive into the page directory (Zip Slip safe) */
    storeZip(shareId: string, zipBase64: string): {
        fileCount: number;
        hasIndex: boolean;
    };
    /** Blocked sensitive directory prefixes (SSRF prevention) */
    private static readonly BLOCKED_PATHS;
    /**
     * Validate that folderPath is not a sensitive system directory.
     * Called before storeFolder to prevent SSRF via deploy_folder MCP tool.
     */
    static validateFolderPath(folderPath: string): {
        valid: boolean;
        error?: string;
    };
    /** Copy a local folder's contents into the page directory */
    storeFolder(shareId: string, folderPath: string): {
        fileCount: number;
        hasIndex: boolean;
    };
    /** Read a file from a page's directory, returns null if not found */
    readFile(shareId: string, filePath: string): Buffer | null;
    /** Check if a page's directory exists */
    pageExists(shareId: string): boolean;
    /** List all files recursively in a directory */
    listFiles(dir: string): string[];
    /** Get all files in a page directory with relative paths */
    getPageFiles(shareId: string): string[];
    /** Delete a page's files */
    deletePage(shareId: string): boolean;
    /** Validate that an HTML string contains basic HTML structure */
    static validateHtml(value: string): {
        isValid: boolean;
        error?: string;
    };
    /** Create a zip archive from a local folder and return base64 string */
    static folderToZipBase64(folderPath: string): Promise<string>;
    /**
     * Copy directory contents safely.
     * Rejects symbolic links to prevent SSRF via symlink following.
     */
    private copyDir;
    /**
     * Deploy a single file for sharing. Returns the share ID.
     */
    deployFile(filePath: string, name?: string): {
        shareId: string;
        fileName: string;
        fileSize: number;
    };
    /**
     * Deploy a file from buffer (for HTTP upload).
     */
    deployFileFromBuffer(buffer: Buffer, fileName: string, name?: string): {
        shareId: string;
        fileName: string;
        fileCount: number;
        fileSize: number;
    };
    /** Get total size of a directory (public wrapper for internal use) */
    getDirSize(dirPath: string): number;
    /**
     * Deploy a folder for sharing (preserves directory structure).
     * Returns the share ID.
     */
    deployFolder(folderPath: string, name?: string): {
        shareId: string;
        fileCount: number;
        totalSize: number;
    };
    /**
     * Get total size of a directory.
     */
    /** Calculate total size of a directory */
    private calculateDirSize;
    /** Lock or unlock a share (prevents auto-cleanup when locked) */
    setShareLock(shareId: string, locked: boolean): boolean;
    private addToZip;
    /**
     * Get share metadata.
     */
    getShareMeta(shareId: string): any;
    /**
     * List all shares with metadata.
     */
    listShares(): Array<{
        shareId: string;
        meta: any;
    }>;
    /**
     * Cleanup expired shares and pages.
     * Called on each deploy operation (not on a timer).
     * Returns { sharesDeleted, pagesDeleted }.
     */
    cleanupExpired(expireDays: number): {
        sharesDeleted: number;
        pagesDeleted: number;
    };
}
//# sourceMappingURL=storage.d.ts.map