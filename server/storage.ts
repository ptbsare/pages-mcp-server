import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { Readable } from "stream";
import { finished } from "stream/promises";
import AdmZip from "adm-zip";

export class FileStorage {
  private basePath: string;

  constructor(storagePath: string) {
    this.basePath = storagePath;
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  /** Get the directory path for a given shareId */
  private getPageDir(shareId: string): string {
    return path.join(this.basePath, shareId);
  }

  /** Store a single HTML file as index.html for a page */
  storeHtml(shareId: string, html: string): string {
    const dir = this.getPageDir(shareId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, "index.html");
    fs.writeFileSync(filePath, html, "utf-8");
    return filePath;
  }

  /** Extract a base64-encoded zip archive into the page directory (Zip Slip safe) */
  storeZip(shareId: string, zipBase64: string): { fileCount: number; hasIndex: boolean } {
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
      }
    }

    const files = this.listFiles(dir);
    const hasIndex = files.some((f) => f === "index.html");

    return { fileCount: files.length, hasIndex };
  }

  /** Blocked sensitive directory prefixes (SSRF prevention) */
  private static readonly BLOCKED_PATHS = [
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
  static validateFolderPath(folderPath: string): { valid: boolean; error?: string } {
    const resolved = path.resolve(folderPath);
    for (const blocked of FileStorage.BLOCKED_PATHS) {
      if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
        return { valid: false, error: `Access denied: path '${folderPath}' is not allowed` };
      }
    }
    return { valid: true };
  }

  /** Copy a local folder's contents into the page directory */
  storeFolder(shareId: string, folderPath: string): { fileCount: number; hasIndex: boolean } {
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
        if (entry.isDirectory()) {
          this.copyDir(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }

    const files = this.listFiles(dir);
    const hasIndex = files.some((f) => f === "index.html");

    return { fileCount: files.length, hasIndex };
  }

  /** Read a file from a page's directory, returns null if not found */
  readFile(shareId: string, filePath: string): Buffer | null {
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
  pageExists(shareId: string): boolean {
    return fs.existsSync(this.getPageDir(shareId));
  }

  /** List all files recursively in a directory */
  listFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        results.push(entry.name);
      } else if (entry.isDirectory()) {
        const subFiles = this.listFiles(path.join(dir, entry.name));
        for (const sf of subFiles) {
          results.push(path.join(entry.name, sf));
        }
      }
    }
    return results;
  }

  /** Get all files in a page directory with relative paths */
  getPageFiles(shareId: string): string[] {
    return this.listFiles(this.getPageDir(shareId));
  }

  /** Delete a page's files */
  deletePage(shareId: string): boolean {
    const dir = this.getPageDir(shareId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Validate that an HTML string contains basic HTML structure */
  static validateHtml(value: string): { isValid: boolean; error?: string } {
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
  static async folderToZipBase64(folderPath: string): Promise<string> {
    const { execSync } = await import("child_process");
    const isWindows = process.platform === "win32";

    if (isWindows) {
      // Use PowerShell on Windows
      const absPath = path.resolve(folderPath);
      const tmpFile = path.join(require("os").tmpdir(), `pages-upload-${Date.now()}.zip`);
      execSync(
        `powershell -Command "Compress-Archive -Path '${absPath}\\*' -DestinationPath '${tmpFile}' -Force"`
      );
      const base64 = fs.readFileSync(tmpFile).toString("base64");
      fs.unlinkSync(tmpFile);
      return base64;
    } else {
      // Use zip on Unix
      const absPath = path.resolve(folderPath);
      const tmpFile = path.join(require("os").tmpdir(), `pages-upload-${Date.now()}.zip`);
      execSync(`cd "${absPath}" && zip -r "${tmpFile}" .`);
      const base64 = fs.readFileSync(tmpFile).toString("base64");
      fs.unlinkSync(tmpFile);
      return base64;
    }
  }

  private copyDir(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
