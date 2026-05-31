import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import AdmZip from "adm-zip";
export class FileStorage {
    basePath;
    constructor(storagePath) {
        this.basePath = storagePath;
        if (!fs.existsSync(this.basePath)) {
            fs.mkdirSync(this.basePath, { recursive: true });
        }
    }
    /** Get the directory path for a given shareId */
    getPageDir(shareId) {
        return path.join(this.basePath, shareId);
    }
    /** Store a single HTML file as index.html for a page */
    storeHtml(shareId, html) {
        const dir = this.getPageDir(shareId);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, "index.html");
        fs.writeFileSync(filePath, html, "utf-8");
        return filePath;
    }
    /** Extract a base64-encoded zip archive into the page directory (Zip Slip safe) */
    storeZip(shareId, zipBase64) {
        const dir = this.getPageDir(shareId);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const zipBuffer = Buffer.from(zipBase64, "base64");
        const zip = new AdmZip(zipBuffer);
        const entries = zip.getEntries();
        const dirResolved = path.resolve(dir);
        for (const entry of entries) {
            // Reject absolute paths
            if (path.isAbsolute(entry.entryName)) {
                throw new Error(`Zip contains absolute path: ${entry.entryName}`);
            }
            // Reject any parent directory references
            if (entry.entryName.includes("..")) {
                throw new Error(`Zip contains unsafe path: ${entry.entryName}`);
            }
            // Resolve the final path and ensure it's inside dir
            const entryPath = path.resolve(dirResolved, entry.entryName);
            if (!entryPath.startsWith(dirResolved + path.sep) && entryPath !== dirResolved) {
                throw new Error(`Zip contains unsafe path: ${entry.entryName}`);
            }
            // Reject directory entries (we only want files)
            if (entry.entryName.endsWith("/")) {
                continue;
            }
            // Ensure parent directory exists
            const parentDir = path.dirname(entryPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }
            // Extract file content manually (no extractAllTo)
            const content = entry.getData();
            if (content) {
                fs.writeFileSync(entryPath, content);
                // Verify the written file is not a symlink (TOCTOU-safe check)
                const fileStat = fs.lstatSync(entryPath);
                if (fileStat.isSymbolicLink()) {
                    fs.unlinkSync(entryPath);
                    throw new Error(`Zip contains symbolic link: ${entry.entryName}`);
                }
            }
        }
        const files = this.listFiles(dir);
        const hasIndex = files.some((f) => f === "index.html");
        const totalSize = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
        return { fileCount: files.length, totalSize, hasIndex };
    }
    /** Blocked sensitive directory prefixes (SSRF prevention) */
    static BLOCKED_PATHS = [
        "/etc", "/root", "/home",
        "/proc", "/sys", "/dev", "/boot",
        "/bin", "/sbin", "/lib", "/lib64",
        "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib64",
        "/var/log", "/var/spool", "/var/mail",
        "C:\\Windows", "C:\\Program Files", "C:\\ProgramData",
    ];
    /**
     * Validate that folderPath is not a sensitive system directory.
     * Called before storeFolder to prevent SSRF via deploy_folder MCP tool.
     */
    static validateFolderPath(folderPath) {
        const resolved = path.resolve(folderPath);
        for (const blocked of FileStorage.BLOCKED_PATHS) {
            if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
                return { valid: false, error: `Access denied: path '${folderPath}' is not allowed` };
            }
        }
        return { valid: true };
    }
    /** Copy a local folder's contents into the page directory */
    storeFolder(shareId, folderPath) {
        const dir = this.getPageDir(shareId);
        // Remove existing content if any
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        fs.mkdirSync(dir, { recursive: true });
        // Copy contents of folderPath into dir (not folderPath itself)
        if (fs.existsSync(folderPath)) {
            const entries = fs.readdirSync(folderPath, { withFileTypes: true });
            for (const entry of entries) {
                const srcPath = path.join(folderPath, entry.name);
                const destPath = path.join(dir, entry.name);
                // SECURITY: Check for symbolic links before copying
                const srcLstat = fs.lstatSync(srcPath);
                if (srcLstat.isSymbolicLink()) {
                    throw new Error(`Symbolic links are not allowed: ${srcPath}`);
                }
                if (entry.isDirectory()) {
                    this.copyDir(srcPath, destPath);
                }
                else {
                    fs.copyFileSync(srcPath, destPath);
                }
            }
        }
        const files = this.listFiles(dir);
        const hasIndex = files.some((f) => f === "index.html");
        const totalSize = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
        return { fileCount: files.length, totalSize, hasIndex };
    }
    /** Read a file from a page's directory, returns null if not found */
    readFile(shareId, filePath) {
        // Reject absolute paths and parent directory references
        if (path.isAbsolute(filePath) || filePath.includes("..")) {
            return null;
        }
        const pageDir = path.resolve(this.getPageDir(shareId));
        const fullPath = path.resolve(pageDir, filePath);
        // Strict containment check
        if (!fullPath.startsWith(pageDir + path.sep)) {
            return null;
        }
        if (!fs.existsSync(fullPath)) {
            return null;
        }
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) {
            return null;
        }
        return fs.readFileSync(fullPath);
    }
    /** Check if a page's directory exists */
    pageExists(shareId) {
        return fs.existsSync(this.getPageDir(shareId));
    }
    /** List all files recursively in a directory */
    listFiles(dir) {
        const results = [];
        if (!fs.existsSync(dir))
            return results;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                results.push(entry.name);
            }
            else if (entry.isDirectory()) {
                const subFiles = this.listFiles(path.join(dir, entry.name));
                for (const sf of subFiles) {
                    results.push(path.join(entry.name, sf));
                }
            }
        }
        return results;
    }
    /** Get all files in a page directory with relative paths */
    getPageFiles(shareId) {
        return this.listFiles(this.getPageDir(shareId));
    }
    /** Delete a page's files */
    deletePage(shareId) {
        const dir = this.getPageDir(shareId);
        if (!fs.existsSync(dir))
            return false;
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
    }
    /** Validate that an HTML string contains basic HTML structure */
    static validateHtml(value) {
        const hasHtmlTag = /<html[^>]*>/i.test(value);
        const hasBodyTag = /<body[^>]*>/i.test(value);
        if (!hasHtmlTag) {
            return { isValid: false, error: "Value must contain an <html> tag." };
        }
        if (!hasBodyTag) {
            return { isValid: false, error: "Value must contain a <body> tag." };
        }
        return { isValid: true };
    }
    /** Create a zip archive from a local folder and return base64 string */
    static async folderToZipBase64(folderPath) {
        const { execSync } = await import("child_process");
        const isWindows = process.platform === "win32";
        if (isWindows) {
            // Use PowerShell on Windows
            const absPath = path.resolve(folderPath);
            const tmpFile = path.join(require("os").tmpdir(), `pages-upload-${Date.now()}.zip`);
            execSync(`powershell -Command "Compress-Archive -Path '${absPath}\\*' -DestinationPath '${tmpFile}' -Force"`);
            const base64 = fs.readFileSync(tmpFile).toString("base64");
            fs.unlinkSync(tmpFile);
            return base64;
        }
        else {
            // Use zip on Unix
            const absPath = path.resolve(folderPath);
            const tmpFile = path.join(require("os").tmpdir(), `pages-upload-${Date.now()}.zip`);
            execSync(`cd "${absPath}" && zip -r "${tmpFile}" .`);
            const base64 = fs.readFileSync(tmpFile).toString("base64");
            fs.unlinkSync(tmpFile);
            return base64;
        }
    }
    /**
     * Copy directory contents safely.
     * Rejects symbolic links to prevent SSRF via symlink following.
     */
    copyDir(src, dest) {
        // Check if src itself is a symlink
        const srcLstat = fs.lstatSync(src);
        if (srcLstat.isSymbolicLink()) {
            throw new Error(`Symbolic links are not allowed: ${src}`);
        }
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            // Check for symlinks (lstatSync doesn't follow symlinks)
            const entryLstat = fs.lstatSync(srcPath);
            if (entryLstat.isSymbolicLink()) {
                throw new Error(`Symbolic links are not allowed: ${srcPath}`);
            }
            if (entry.isDirectory()) {
                this.copyDir(srcPath, destPath);
            }
            else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }
    // ─── File Sharing ──────────────────────────────────────
    /**
     * Deploy a single file for sharing. Returns the share ID.
     */
    deployFile(filePath, name) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            throw new Error(`Path is not a file: ${filePath}`);
        }
        // Check size limit (1GB for single file)
        const MAX_SIZE = 1024 * 1024 * 1024;
        if (stat.size > MAX_SIZE) {
            throw new Error(`File too large (${stat.size} bytes). Max: ${MAX_SIZE} bytes`);
        }
        const shareId = nanoid(12);
        const dir = this.getPageDir(shareId);
        fs.mkdirSync(dir, { recursive: true });
        const fileName = path.basename(filePath);
        fs.copyFileSync(filePath, path.join(dir, fileName));
        // Store metadata
        return { shareId, fileName, fileSize: stat.size };
    }
    /**
     * Deploy a file from buffer (for HTTP upload).
     */
    deployFileFromBuffer(buffer, fileName, name) {
        const MAX_SIZE = 1024 * 1024 * 1024; // 1GB
        if (buffer.length > MAX_SIZE) {
            throw new Error(`File too large (${buffer.length} bytes). Max: ${MAX_SIZE} bytes`);
        }
        const shareId = nanoid(12);
        const dir = this.getPageDir(shareId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, fileName), buffer);
        return { shareId, fileName, fileCount: 1, fileSize: buffer.length };
    }
    /** Get total size of a directory (public wrapper for internal use) */
    getDirSize(dirPath) {
        return this.calculateDirSize(dirPath);
    }
    /**
     * Deploy a folder for sharing (preserves directory structure).
     * Returns the share ID.
     */
    deployFolder(folderPath, name) {
        if (!fs.existsSync(folderPath)) {
            throw new Error(`Folder not found: ${folderPath}`);
        }
        const stat = fs.statSync(folderPath);
        if (!stat.isDirectory()) {
            throw new Error(`Path is not a directory: ${folderPath}`);
        }
        // Check total size (1GB limit)
        const MAX_SIZE = 1024 * 1024 * 1024;
        const totalSize = this.calculateDirSize(folderPath);
        if (totalSize > MAX_SIZE) {
            throw new Error(`Folder too large (${totalSize} bytes). Max: ${MAX_SIZE} bytes`);
        }
        const shareId = nanoid(12);
        const dir = this.getPageDir(shareId);
        fs.mkdirSync(dir, { recursive: true });
        // Copy folder contents preserving structure
        this.copyDir(folderPath, dir);
        const fileCount = this.listFiles(dir).length;
        return { shareId, fileCount, totalSize };
    }
    /**
     * Get total size of a directory.
     */
    /** Calculate total size of a directory */
    calculateDirSize(dirPath) {
        let size = 0;
        if (!fs.existsSync(dirPath))
            return 0;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const p = path.join(dirPath, entry.name);
            try {
                const lstat = fs.lstatSync(p);
                if (lstat.isSymbolicLink())
                    continue;
                if (entry.isDirectory()) {
                    size += this.calculateDirSize(p);
                }
                else {
                    size += lstat.size;
                }
            }
            catch { /* ignore inaccessible files */ }
        }
        return size;
    }
    /** Lock or unlock a page (prevents auto-cleanup when locked). Uses database. */
    setShareLock(shareId, locked) {
        const pageDir = this.getPageDir(shareId);
        if (!fs.existsSync(pageDir))
            return false;
        return true;
    }
    addToZip(zip, dirPath, zipPath) {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(dirPath, entry.name);
            const entryZipPath = zipPath + entry.name;
            const lstat = fs.lstatSync(srcPath);
            if (lstat.isSymbolicLink())
                continue; // Skip symlinks
            if (entry.isDirectory()) {
                this.addToZip(zip, srcPath, entryZipPath + "/");
            }
            else {
                zip.addLocalFile(srcPath, zipPath);
            }
        }
    }
    /**
     * Get share metadata.
     */
    /** Get share metadata from database (no .meta file needed) */
    async getShareMeta(shareId, db) {
        const page = await db.getPageByShareId(shareId);
        if (!page)
            return null;
        const pageDir = this.getPageDir(shareId);
        const files = this.listFiles(pageDir);
        return {
            type: page.type || (files.length > 1 ? "folder" : "file"),
            folderName: page.name,
            fileName: page.type === "file" ? page.name : undefined,
            fileCount: page.fileCount || files.length,
            totalSize: page.totalSize || 0,
            createdAt: page.createdAt,
            locked: page.locked || false,
        };
    }
    /**
     * List all shares with metadata.
     */
    async listShares(db) {
        const results = [];
        if (!fs.existsSync(this.basePath))
            return results;
        const entries = fs.readdirSync(this.basePath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const meta = await this.getShareMeta(entry.name, db);
            if (meta) {
                results.push({ shareId: entry.name, meta });
            }
        }
        return results;
    }
    /**
     * Cleanup expired shares and pages.
     * Called on each deploy operation (not on a timer).
     * Returns { sharesDeleted, pagesDeleted }.
     */
    async cleanupExpired(expireDays, db) {
        if (expireDays <= 0)
            return { sharesDeleted: 0, pagesDeleted: 0 };
        const now = Date.now();
        const maxAge = expireDays * 24 * 60 * 60 * 1000;
        let sharesDeleted = 0;
        let pagesDeleted = 0;
        if (!fs.existsSync(this.basePath))
            return { sharesDeleted, pagesDeleted };
        const entries = fs.readdirSync(this.basePath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            // Check database for locked status and creation date
            try {
                const page = await db.getPageByShareId(entry.name);
                if (!page)
                    continue;
                if (page.locked)
                    continue;
                const created = new Date(page.createdAt || 0).getTime();
                if (created && now - created > maxAge) {
                    this.deletePage(entry.name);
                    pagesDeleted++;
                }
            }
            catch { /* ignore */ }
        }
        return { sharesDeleted, pagesDeleted };
    }
}
//# sourceMappingURL=storage.js.map