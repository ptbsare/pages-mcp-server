/* eslint-disable @typescript-eslint/no-explicit-any */
import express from "express";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import mime from "mime-types";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import crypto from "crypto";
import { PagesDatabase } from "./db.js";
import { FileStorage } from "./storage.js";
import { bearerAuth } from "./auth.js";
import { buildUrl } from "../shared/types.js";
// ─── OTP helpers ────────────────────────────────────────────
function generateOtpSecret() {
    // Base32 encoded 160-bit (20-byte) random secret → 32 base32 chars
    const bytes = crypto.randomBytes(20);
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let result = "";
    let buffer = 0, bitsLeft = 0;
    for (let i = 0; i < bytes.length; i++) {
        buffer = (buffer << 8) | bytes[i];
        bitsLeft += 8;
        while (bitsLeft >= 5) {
            bitsLeft -= 5;
            result += chars[(buffer >> bitsLeft) & 0x1f];
        }
    }
    // Pad remaining bits
    if (bitsLeft > 0) {
        result += chars[(buffer << (5 - bitsLeft)) & 0x1f];
    }
    return result;
}
function base32Decode(input) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleaned = input.replace(/\s/g, "").toUpperCase();
    const bytes = [];
    let buffer = 0;
    let bitsLeft = 0;
    for (const c of cleaned) {
        const val = chars.indexOf(c);
        if (val === -1)
            continue;
        buffer = (buffer << 5) | val;
        bitsLeft += 5;
        if (bitsLeft >= 8) {
            bitsLeft -= 8;
            bytes.push((buffer >> bitsLeft) & 0xff);
        }
    }
    return Buffer.from(bytes);
}
function verifyOtpToken(secret, token) {
    const STEP = 30;
    const now = Math.floor(Date.now() / 1000);
    const key = base32Decode(secret);
    for (let offset = -1; offset <= 1; offset++) {
        const counter = Math.floor((now + offset * STEP) / STEP);
        const buf = Buffer.alloc(8);
        let tmp = counter;
        for (let i = 7; i >= 0; i--) {
            buf[i] = tmp & 0xff;
            tmp = Math.floor(tmp / 256);
        }
        const hmac = crypto.createHmac("sha1", key);
        hmac.update(buf);
        const digest = hmac.digest();
        const o = digest[digest.length - 1] & 0x0f;
        const code = ((digest[o] & 0x7f) << 24 | (digest[o + 1] & 0xff) << 16 | (digest[o + 2] & 0xff) << 8 | (digest[o + 3] & 0xff)) % 1000000;
        if (code.toString().padStart(6, "0") === token)
            return true;
    }
    return false;
}
function buildOtpauthUrl(secret, username, domain) {
    return `otpauth://totp/${encodeURIComponent(domain)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(domain)}`;
}
function safeEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length)
        return false;
    if (bufA.length === 0)
        return true;
    return crypto.timingSafeEqual(bufA, bufB);
}
export function createApp(config) {
    const app = express();
    // Trust nginx reverse proxy for correct IP detection behind proxy
    app.set("trust proxy", 1);
    const db = new PagesDatabase(config.dbPath);
    const storage = new FileStorage(config.storagePath);
    // Load admin panel HTML template from external file
    // Resolve admin.html relative to this file's location (works with npx, docker, etc.)
    const adminHtmlPath = path.join(path.dirname(new URL(import.meta.url).pathname), "public", "admin.html");
    let adminHtmlTemplate = "";
    try {
        adminHtmlTemplate = fs.readFileSync(adminHtmlPath, "utf-8");
    }
    catch {
        console.error("Admin HTML template not found at", adminHtmlPath);
    }
    // ─── Cookie & Body parsers ────────────────────────────
    app.use(cookieParser());
    // Default: 1MB for most endpoints
    const defaultParser = express.json({ limit: "4mb" });
    // Deploy: 100MB for zip uploads
    const deployBodyParser = express.json({ limit: "1000mb" });
    // Deploy routes need larger body — register BEFORE global default
    app.use("/api/deploy/html", deployBodyParser);
    app.use("/api/deploy/folder", deployBodyParser);
    // Apply default parser globally (won't override /api/deploy)
    app.use(defaultParser);
    // CORS: only allow same-origin requests (no cross-origin API access)
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin) {
            // Allow same-origin only
            const host = req.headers.host;
            try {
                const originUrl = new URL(origin);
                if (originUrl.host === host) {
                    res.setHeader("Access-Control-Allow-Origin", origin);
                    res.setHeader("Vary", "Origin");
                }
            }
            catch {
                // Invalid origin, don't set CORS headers
            }
        }
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-OTP-Code");
        if (req.method === "OPTIONS") {
            res.sendStatus(204);
            return;
        }
        next();
    });
    // ─── Rate Limiting ─────────────────────────────────────
    // General API rate limit: 100 requests per 15 minutes per IP
    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many requests, please try again later" },
    });
    // Stricter limit for admin endpoints: 30 requests per 15 minutes
    const adminLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many admin requests, please try again later" },
    });
    // Very strict for OTP verification: 10 attempts per 15 minutes
    const otpLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many OTP attempts, please try again later" },
    });
    // Deploy limit: 20 per 15 minutes
    const deployLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many deploy requests, please try again later" },
    });
    // ─── Block access to sensitive files ──────────────────
    app.use((req, res, next) => {
        const p = req.path;
        // Block access to database files, hidden files, and backup files
        if (p.endsWith(".db") || p.endsWith(".sqlite") || p.endsWith(".sqlite3") ||
            p.includes("/.env") || p.includes("/.git/") ||
            p.match(/\.(bak|old|tmp|swp|~)$/)) {
            res.status(404).send("Not found");
            return;
        }
        next();
    });
    // ─── 1. Static page serving: /s/:shareId ─────────────────
    // Serve static pages: /s/:shareId and /s/:shareId/
    // Redirect to trailing slash so relative paths (./a.png) resolve correctly
    app.get("/s/:shareId", async (req, res) => {
        const { shareId } = req.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
            res.status(400).send("<h1>400 - Bad Request</h1>");
            return;
        }
        // Always redirect to trailing slash for directory-style access
        if (!req.path.endsWith("/")) {
            return res.redirect(301, req.path + "/");
        }
        return serveStaticPage(req, res, shareId);
    });
    app.get("/s/:shareId/", async (req, res) => {
        const { shareId } = req.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
            res.status(400).send("<h1>400 - Bad Request</h1>");
            return;
        }
        return serveStaticPage(req, res, shareId);
    });
    async function serveStaticPage(req, res, shareId) {
        const page = await db.getPageByShareId(shareId);
        if (!page) {
            res.status(404).send("<h1>404 - Page not found</h1>");
            return;
        }
        const pageDir = path.resolve(config.storagePath, shareId);
        const fullPath = path.join(pageDir, "index.html");
        if (!path.resolve(fullPath).startsWith(pageDir + path.sep)) {
            res.status(403).send("<h1>403 - Forbidden</h1>");
            return;
        }
        if (!fs.existsSync(fullPath)) {
            res.status(404).send("<h1>404 - File not found</h1>");
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        // CSP for share pages: default allows external scripts (for CDN, polyfill, etc.)
        // Set STRICT_SHARE_CSP=1 to enforce strict same-origin only
        const strictCsp = process.env.STRICT_SHARE_CSP === "1";
        const scriptSrc = strictCsp ? "'self'" : "* 'unsafe-inline'";
        res.setHeader("Content-Security-Policy", `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src 'none'; object-src 'none'`);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-XSS-Protection", "1; mode=block");
        res.sendFile(fullPath);
    }
    app.get("/s/:shareId/*", async (req, res) => {
        const { shareId } = req.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
            res.status(400).send("<h1>400 - Bad Request</h1>");
            return;
        }
        const page = await db.getPageByShareId(shareId);
        if (!page) {
            res.status(404).send("<h1>404 - Page not found</h1>");
            return;
        }
        const pageDir = path.resolve(config.storagePath, shareId);
        // Decode and sanitize the sub-path
        let subPath = decodeURIComponent(req.params[0] || "");
        // If empty (trailing slash), serve index.html
        if (!subPath || subPath === "/") {
            return serveStaticPage(req, res, shareId);
        }
        // Reject absolute paths, null bytes
        if (path.isAbsolute(subPath) || subPath.includes("\0")) {
            res.status(403).send("<h1>403 - Forbidden</h1>");
            return;
        }
        // Reject any parent directory references (defense in depth)
        if (subPath.includes("..")) {
            res.status(403).send("<h1>403 - Forbidden</h1>");
            return;
        }
        // Normalize and resolve
        const fullPath = path.resolve(pageDir, subPath);
        // Strict containment check: resolved path must be under pageDir
        if (!fullPath.startsWith(pageDir + path.sep) && fullPath !== pageDir) {
            res.status(403).send("<h1>403 - Forbidden</h1>");
            return;
        }
        if (!fs.existsSync(fullPath)) {
            res.status(404).send("<h1>404 - File not found</h1>");
            return;
        }
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) {
            res.status(404).send("<h1>404 - Not a file</h1>");
            return;
        }
        const mimeType = mime.lookup(fullPath) || "application/octet-stream";
        res.setHeader("Content-Type", mimeType);
        // Sub-resources: default allows everything (matching index.html policy)
        // Set STRICT_SHARE_CSP=1 to enforce same-origin only
        const strictCspSub = process.env.STRICT_SHARE_CSP === "1";
        if (strictCspSub) {
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'");
        }
        else {
            res.setHeader("Content-Security-Policy", "default-src *; script-src *; style-src *; img-src *; font-src *; frame-src 'none'; object-src 'none'");
        }
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.sendFile(fullPath);
    });
    // ─── Security helpers ──────────────────────────────────
    const sanitizeFilename = (name) => name.replace(/[\r\n"\\]/g, '_').replace(/[\x00-\x1f]/g, '');
    // ─── File Share Routes ──────────────────────────────────
    const shareHtmlPath = path.join(path.dirname(new URL(import.meta.url).pathname), "public", "share.html");
    let shareHtmlTemplate = "";
    try {
        shareHtmlTemplate = fs.readFileSync(shareHtmlPath, "utf-8");
    }
    catch {
        console.error("share.html not found");
    }
    // IMPORTANT: /list and /raw routes must be registered BEFORE /f/:shareId
    // so they are matched first by Express.
    // List directory contents (JSON API)
    app.get("/f/:shareId/list", async (req, res) => {
        const { shareId } = req.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
            res.status(400).json({ error: "Bad Request" });
            return;
        }
        const meta = await storage.getShareMeta(shareId, db);
        if (!meta) {
            res.status(404).json({ error: "Not found" });
            return;
        }
        const pageDir = path.join(config.storagePath, shareId);
        const entries = fs.readdirSync(pageDir, { withFileTypes: true });
        const result = {
            folderName: meta.folderName,
            currentPath: "",
            totalSize: meta.totalSize || 0,
            entries: entries.map(e => {
                const p = path.join(pageDir, e.name);
                const s = fs.lstatSync(p);
                if (s.isSymbolicLink())
                    return null;
                return {
                    name: e.name,
                    isDirectory: e.isDirectory(),
                    size: e.isDirectory() ? 0 : s.size,
                    fileCount: e.isDirectory() ? fs.readdirSync(p).length : 0,
                };
            }).filter(Boolean),
        };
        res.json(result);
    });
    // List subdirectory contents
    app.get("/f/:shareId/list/**", async (req, res) => {
        const { shareId } = req.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
            res.status(400).json({ error: "Bad Request" });
            return;
        }
        const meta = await storage.getShareMeta(shareId, db);
        if (!meta) {
            res.status(404).json({ error: "Not found" });
            return;
        }
        const subPath = req.params[0] || "";
        const dirPath = path.join(config.storagePath, shareId, subPath);
        const resolvedDir = path.resolve(dirPath);
        const shareRoot = path.resolve(path.join(config.storagePath, shareId));
        if (!resolvedDir.startsWith(shareRoot + path.sep) && resolvedDir !== shareRoot) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
            res.status(404).json({ error: "Directory not found" });
            return;
        }
        const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
        const result = {
            folderName: meta.folderName,
            currentPath: subPath,
            totalSize: meta.totalSize || 0,
            entries: entries.map(e => {
                const p = path.join(resolvedDir, e.name);
                const s = fs.lstatSync(p);
                if (s.isSymbolicLink())
                    return null;
                return {
                    name: e.name,
                    isDirectory: e.isDirectory(),
                    size: e.isDirectory() ? 0 : s.size,
                    fileCount: e.isDirectory() ? fs.readdirSync(p).length : 0,
                };
            }).filter(Boolean),
        };
        res.json(result);
    });
    // Download file or zip
    app.get("/f/:shareId/raw", async (req, res) => {
        const { shareId } = req.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
            res.status(400).send("Bad Request");
            return;
        }
        const meta = await storage.getShareMeta(shareId, db);
        if (!meta) {
            res.status(404).send("Not found");
            return;
        }
        if (meta.type === "file") {
            const filePath = path.join(config.storagePath, shareId, meta.fileName);
            res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFilename(meta.fileName)}"`);
            res.sendFile(filePath);
        }
        else {
            // Zip the entire share directory
            const AdmZip = (await import("adm-zip")).default;
            const zip = new AdmZip();
            const pageDir = path.join(config.storagePath, shareId);
            const addDir = (dir, zipPath) => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const sp = path.join(dir, e.name);
                    if (fs.lstatSync(sp).isSymbolicLink())
                        continue;
                    if (e.isDirectory())
                        addDir(sp, zipPath + e.name + "/");
                    else
                        zip.addFile(zipPath + e.name, fs.readFileSync(sp));
                }
            };
            addDir(pageDir, (meta.folderName || shareId) + "/");
            const zipName = sanitizeFilename((meta.folderName || shareId) + ".zip");
            res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
            res.setHeader("Content-Type", "application/zip");
            res.send(zip.toBuffer());
        }
    });
    // ─── File Upload API (for local stdio client) ──────────
    // Uses express.raw() to receive binary body, then processes in memory
    const rawBodyParser = express.raw({ limit: "1000mb", type: "application/octet-stream" });
    app.post("/api/deploy/file", bearerAuth(db), rawBodyParser, async (req, res) => {
        const MAX_SIZE = 1024 * 1024 * 1024; // 1GB
        try {
            const body = req.body;
            if (!body || body.length === 0)
                throw new Error("Empty file");
            if (body.length > MAX_SIZE)
                throw new Error("File too large (max 1GB)");
            // Sanitize filename
            let fileName = String(req.query.filename || `upload-${Date.now()}`);
            fileName = fileName.replace(/[\\/]/g, "_").replace(/[\x00-\x1f]/g, "");
            if (!fileName)
                fileName = `upload-${Date.now()}`;
            const isZip = fileName.toLowerCase().endsWith(".zip");
            const name = String(req.query.name || "") || undefined;
            const description = String(req.query.description || "") || undefined;
            if (isZip) {
                // Secure zip: check entries BEFORE extraction
                const AdmZip = (await import("adm-zip")).default;
                const zip = new AdmZip(body);
                const entries = zip.getEntries();
                for (const entry of entries) {
                    if (entry.entryName.includes("..") || path.isAbsolute(entry.entryName)) {
                        throw new Error("Zip contains unsafe path");
                    }
                }
                const shareId = nanoid(12);
                const dir = path.join(config.storagePath, shareId);
                fs.mkdirSync(dir, { recursive: true });
                for (const entry of entries) {
                    const entryPath = path.join(dir, entry.entryName);
                    const entryDir = path.dirname(entryPath);
                    if (!fs.existsSync(entryDir))
                        fs.mkdirSync(entryDir, { recursive: true });
                    if (!entry.entryName.endsWith("/")) {
                        fs.writeFileSync(entryPath, entry.getData());
                    }
                }
                const fileCount = storage.listFiles(dir).length;
                const totalSize = storage.getDirSize(dir);
                const publicUrl = buildUrl(config.domain, config.outPort);
                const id = nanoid();
                const now = new Date().toISOString();
                db.createPage({ id, shareId, name: name || fileName.replace(/\.zip$/i, ""), description, type: "folder", fileCount, totalSize, createdAt: now, updatedAt: now });
                res.json({ success: true, shareId, url: `${publicUrl}/f/${shareId}`, fileCount, totalSize });
            }
            else {
                const result = storage.deployFileFromBuffer(body, fileName, name);
                const publicUrl = buildUrl(config.domain, config.outPort);
                const dlUrl = `${publicUrl}/f/${result.shareId}/raw/${encodeURIComponent(result.fileName)}`;
                const id2 = nanoid();
                const now2 = new Date().toISOString();
                db.createPage({ id: id2, shareId: result.shareId, name: name || fileName, description, type: "file", fileCount: 1, totalSize: result.fileSize, createdAt: now2, updatedAt: now2 });
                res.json({ success: true, shareId: result.shareId, url: dlUrl, fileName: result.fileName, fileSize: result.fileSize });
            }
            const expireDays = parseInt(process.env.SHARE_EXPIRE_DAYS || "0", 10);
            if (expireDays > 0)
                setImmediate(() => storage.cleanupExpired(expireDays, db));
        }
        catch (err) {
            console.error("Upload error:", err);
            res.status(500).json({ error: "Upload failed" });
        }
    });
    app.get("/f/:shareId/raw/**", async (req, res) => {
        const { shareId } = req.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
            res.status(400).send("Bad Request");
            return;
        }
        const meta = await storage.getShareMeta(shareId, db);
        if (!meta) {
            res.status(404).send("Not found");
            return;
        }
        const filePath = req.params[0] || "";
        const isZip = req.query.zip === "1";
        const pageDir = path.join(config.storagePath, shareId);
        if (isZip) {
            const AdmZip = (await import("adm-zip")).default;
            const zip = new AdmZip();
            const zipSource = path.join(pageDir, filePath);
            if (!fs.existsSync(zipSource)) {
                res.status(404).send("Not found");
                return;
            }
            const addDir = (dir, zipPath) => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const sp = path.join(dir, e.name);
                    if (fs.lstatSync(sp).isSymbolicLink())
                        continue;
                    if (e.isDirectory())
                        addDir(sp, zipPath + e.name + "/");
                    else
                        zip.addFile(zipPath + e.name, fs.readFileSync(sp));
                }
            };
            if (fs.statSync(zipSource).isDirectory())
                addDir(zipSource, path.basename(filePath) + "/");
            else
                zip.addFile(path.basename(filePath), fs.readFileSync(zipSource));
            const zipName = sanitizeFilename((filePath ? path.basename(filePath) : meta.folderName || shareId) + ".zip");
            res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
            res.setHeader("Content-Type", "application/zip");
            res.send(zip.toBuffer());
        }
        else {
            const resolvedFile = path.resolve(pageDir, filePath);
            if (!resolvedFile.startsWith(pageDir + path.sep)) {
                res.status(403).send("Forbidden");
                return;
            }
            if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
                res.status(404).send("File not found");
                return;
            }
            res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFilename(path.basename(filePath))}"`);
            res.sendFile(resolvedFile);
        }
    });
    // Share page (must be LAST among /f/:shareId routes)
    app.get("/f/:shareId", async (req, res) => {
        const { shareId } = req.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
            res.status(400).send("Bad Request");
            return;
        }
        const meta = await storage.getShareMeta(shareId, db);
        if (!meta) {
            res.status(404).send("Not found");
            return;
        }
        if (meta.type === "file") {
            // Single file: redirect to direct download
            res.redirect(302, `/f/${shareId}/raw/${encodeURIComponent(meta.fileName)}`);
            return;
        }
        // Folder: render share page (escape placeholders to prevent injection)
        const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const html = shareHtmlTemplate
            .replace(/__TITLE__/g, esc(meta.folderName || "File Share"))
            .replace(/__META__/g, esc(`${meta.fileCount} files · ${meta.totalSize || 0} bytes · ${meta.createdAt}`))
            .replace(/__SHARE_ID__/g, esc(shareId))
            .replace(/__CONTENT__/g, ""); // Content loaded via JS
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; img-src 'self' blob: data:; font-src cdn.jsdelivr.net; connect-src 'self'; frame-src 'none'; object-src 'none'");
        res.send(html);
    });
    // List directory contents (JSON API for share page)
    app.get("/f/:shareId/list/**", async (req, res) => {
        const { shareId } = req.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
            res.status(400).json({ error: "Bad Request" });
            return;
        }
        const meta = await storage.getShareMeta(shareId, db);
        if (!meta) {
            res.status(404).json({ error: "Not found" });
            return;
        }
        const subPath = req.params[0] || "";
        const dirPath = path.join(config.storagePath, shareId, subPath);
        const resolvedDir = path.resolve(dirPath);
        const shareRoot = path.resolve(path.join(config.storagePath, shareId));
        if (!resolvedDir.startsWith(shareRoot + path.sep) && resolvedDir !== shareRoot) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
            res.status(404).json({ error: "Directory not found" });
            return;
        }
        const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
        const result = {
            folderName: meta.folderName,
            currentPath: subPath,
            totalSize: meta.totalSize || 0,
            entries: entries.map(e => {
                const p = path.join(resolvedDir, e.name);
                const s = fs.lstatSync(p);
                if (s.isSymbolicLink())
                    return null;
                return {
                    name: e.name,
                    isDirectory: e.isDirectory(),
                    size: e.isDirectory() ? 0 : s.size,
                    fileCount: e.isDirectory() ? fs.readdirSync(p).length : 0,
                };
            }).filter(Boolean),
        };
        res.json(result);
    });
    // Download file or zip
    app.get("/f/:shareId/raw/**", async (req, res) => {
        const { shareId } = req.params;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(shareId)) {
            res.status(400).send("Bad Request");
            return;
        }
        const meta = await storage.getShareMeta(shareId, db);
        if (!meta) {
            res.status(404).send("Not found");
            return;
        }
        const filePath = req.params[0] || "";
        const isZip = req.query.zip === "1" || !filePath;
        const pageDir = path.join(config.storagePath, shareId);
        if (isZip) {
            // Zip the entire share directory (or a subdirectory if filePath is a dir)
            const AdmZip = require("adm-zip");
            const zip = new AdmZip();
            const zipSource = filePath ? path.join(pageDir, filePath) : pageDir;
            if (!fs.existsSync(zipSource)) {
                res.status(404).send("Not found");
                return;
            }
            if (fs.statSync(zipSource).isDirectory()) {
                const addDir = (dir, zipPath) => {
                    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                        const sp = path.join(dir, e.name);
                        if (fs.lstatSync(sp).isSymbolicLink())
                            continue;
                        if (e.isDirectory())
                            addDir(sp, zipPath + e.name + "/");
                        else
                            zip.addFile(zipPath + e.name, fs.readFileSync(sp));
                    }
                };
                const rootName = filePath ? path.basename(filePath) : (meta.folderName || shareId);
                addDir(zipSource, rootName + "/");
            }
            else {
                zip.addFile(path.basename(filePath), fs.readFileSync(zipSource));
            }
            const zipName = (filePath ? path.basename(filePath) : meta.folderName || shareId) + ".zip";
            res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
            res.setHeader("Content-Type", "application/zip");
            res.send(zip.toBuffer());
        }
        else {
            // Single file download
            const resolvedFile = path.resolve(pageDir, filePath);
            if (!resolvedFile.startsWith(pageDir + path.sep)) {
                res.status(403).send("Forbidden");
                return;
            }
            if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
                res.status(404).send("File not found");
                return;
            }
            res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
            res.sendFile(resolvedFile);
        }
    });
    // ─── 2. Deploy API (Bearer token) ────────────────────────
    const deployAuth = bearerAuth(db);
    app.post("/api/deploy/html", deployAuth, deployLimiter, deployBodyParser, (req, res) => {
        try {
            const { value, name, description } = req.body;
            if (!value || typeof value !== "string") {
                res.status(400).json({ error: "Missing or invalid 'value' field" });
                return;
            }
            const shareId = nanoid(12);
            const id = nanoid();
            const now = new Date().toISOString();
            storage.storeHtml(shareId, value);
            db.createPage({ id, shareId, name: name || `Page ${shareId}`, description, fileCount: 1, createdAt: now, updatedAt: now });
            const url = `${buildUrl(config.domain, config.outPort)}/s/${shareId}`;
            res.status(201).json({ id, shareId, url, name: name || `Page ${shareId}`, createdAt: now });
            // Trigger async cleanup of expired items
            const expireDays = parseInt(process.env.SHARE_EXPIRE_DAYS || "0", 10);
            if (expireDays > 0)
                setImmediate(() => storage.cleanupExpired(expireDays, db));
        }
        catch (err) {
            res.status(500).json({ error: "Deploy failed" });
        }
    });
    app.post("/api/deploy/folder", deployAuth, deployLimiter, deployBodyParser, (req, res) => {
        try {
            const { zipBase64, name, description } = req.body;
            if (!zipBase64 || typeof zipBase64 !== "string") {
                res.status(400).json({ error: "Missing or invalid 'zipBase64' field" });
                return;
            }
            const shareId = nanoid(12);
            const id = nanoid();
            const now = new Date().toISOString();
            const result = storage.storeZip(shareId, zipBase64);
            db.createPage({ id, shareId, name: name || `Page ${shareId}`, description, fileCount: result.fileCount, totalSize: result.totalSize, type: "page", createdAt: now, updatedAt: now });
            const url = `${buildUrl(config.domain, config.outPort)}/s/${shareId}`;
            res.status(201).json({ id, shareId, url, name: name || `Page ${shareId}`, fileCount: result.fileCount, totalSize: result.totalSize, createdAt: now });
            const expireDays2 = parseInt(process.env.SHARE_EXPIRE_DAYS || "0", 10);
            if (expireDays2 > 0)
                setImmediate(() => storage.cleanupExpired(expireDays2, db));
        }
        catch (err) {
            console.error('Deploy error:', err);
            res.status(500).json({ error: "Deploy failed" });
        }
    });
    // ─── 3. Admin Auth (Session Cookie) ─────────────────────
    // Admin session store: maps session tokens to { created, otpVerified }
    // No expiry — valid until server restart.
    const adminSessions = new Map();
    // Generate a new admin session token
    function createAdminSession(otpVerified) {
        const token = crypto.randomBytes(32).toString("hex");
        adminSessions.set(token, { created: Date.now(), otpVerified });
        return token;
    }
    // Admin auth middleware — checks session cookie, or validates Basic Auth on first login
    const adminAuth = async (req, res, next) => {
        // Check for valid session cookie first
        const sessionCookie = req.cookies?.admin_session;
        if (sessionCookie && adminSessions.has(sessionCookie)) {
            // Session exists — attach to req for downstream use
            req.adminSession = adminSessions.get(sessionCookie);
            next();
            return;
        }
        // No session — require Basic Auth for initial login
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Basic ")) {
            res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
        const colonIdx = decoded.indexOf(":");
        if (colonIdx === -1) {
            res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
            res.status(401).json({ error: "Invalid credentials" });
            return;
        }
        const user = decoded.substring(0, colonIdx);
        const pass = decoded.substring(colonIdx + 1);
        const userValid = safeEqual(user, config.adminUsername);
        const passValid = safeEqual(pass, config.adminPassword);
        if (!userValid || !passValid) {
            res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
            res.status(401).json({ error: "Invalid credentials" });
            return;
        }
        // Basic Auth valid — create session
        const otpEnabled = await db.getOtpEnabled();
        const sessionToken = createAdminSession(!otpEnabled); // otpVerified=true if OTP not enabled
        res.cookie("admin_session", sessionToken, {
            httpOnly: true,
            secure: true,
            sameSite: "strict",
        });
        req.adminSession = adminSessions.get(sessionToken);
        next();
    };
    // OTP middleware — if OTP enabled, require verified OTP session or valid OTP code
    const otpMiddleware = async (req, res, next) => {
        const otpEnabled = await db.getOtpEnabled();
        if (!otpEnabled) {
            next();
            return;
        }
        const session = req.adminSession;
        if (session?.otpVerified) {
            next();
            return;
        }
        // Session not OTP-verified — require OTP code
        const otpHeader = req.headers["x-otp-code"];
        if (!otpHeader || typeof otpHeader !== "string") {
            res.status(403).json({ error: "OTP required", otpRequired: true });
            return;
        }
        const secret = await db.getOtpSecret();
        if (!secret || !verifyOtpToken(secret, otpHeader)) {
            res.status(403).json({ error: "Invalid OTP code" });
            return;
        }
        // OTP valid — mark session as verified
        if (session)
            session.otpVerified = true;
        next();
    };
    // ─── CSRF Protection for Admin API ─────────────────────
    // Session store: maps session IDs to creation timestamps
    const csrfSessions = new Map();
    const SESSION_TTL = 60 * 60 * 1000; // 1 hour
    // Clean up expired sessions periodically
    setInterval(() => {
        const now = Date.now();
        for (const [id, created] of csrfSessions) {
            if (now - created > SESSION_TTL)
                csrfSessions.delete(id);
        }
    }, 5 * 60 * 1000);
    // Generate a CSRF session for the admin dashboard
    app.get("/api/admin/csrf-token", adminAuth, adminLimiter, (req, res) => {
        const sessionId = crypto.randomBytes(16).toString("hex");
        csrfSessions.set(sessionId, Date.now());
        res.json({ csrfToken: sessionId });
    });
    const csrfProtection = (req, res, next) => {
        if (req.method === "GET") {
            next();
            return;
        }
        const csrfToken = req.headers["x-csrf-token"];
        if (!csrfToken || !csrfSessions.has(csrfToken)) {
            res.status(403).json({ error: "CSRF token required or expired" });
            return;
        }
        // Rotate token after use (one-time use for state-changing ops)
        csrfSessions.delete(csrfToken);
        next();
    };
    // ─── 4. Admin API ────────────────────────────────────────
    // OTP status
    app.get("/api/admin/otp/status", adminAuth, adminLimiter, async (req, res) => {
        try {
            const enabled = await db.getOtpEnabled();
            const hasSecret = !!(await db.getOtpSecret());
            res.json({ enabled, hasSecret });
        }
        catch (err) {
            console.error('Admin error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    // ─── File Sharing Management ───────────────────────────
    // List all file shares
    app.get("/api/admin/shares", adminAuth, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const shares = await storage.listShares(db);
            res.json({ shares, total: shares.length });
        }
        catch (err) {
            res.status(500).json({ error: "Internal server error" });
        }
    });
    // Lock/unlock a share
    app.post("/api/admin/shares/:shareId/lock", adminAuth, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const { locked } = req.body;
            const page = await db.getPageByShareId(req.params.shareId);
            if (!page) {
                res.status(404).json({ error: "Share not found" });
                return;
            }
            await db.updatePage(page.id, { locked: !!locked });
            res.json({ success: true, locked: !!locked });
        }
        catch (err) {
            res.status(500).json({ error: "Internal server error" });
        }
    });
    // Delete a share
    app.delete("/api/admin/shares/:shareId", adminAuth, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const meta = await storage.getShareMeta(req.params.shareId, db);
            if (!meta) {
                res.status(404).json({ error: "Share not found" });
                return;
            }
            storage.deletePage(req.params.shareId);
            res.json({ success: true });
        }
        catch (err) {
            res.status(500).json({ error: "Internal server error" });
        }
    });
    // Cleanup expired shares
    app.post("/api/admin/shares/cleanup", adminAuth, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const expireDays = parseInt(process.env.SHARE_EXPIRE_DAYS || "0", 10);
            const deleted = await storage.cleanupExpired(expireDays, db);
            res.json({ success: true, deleted, expireDays });
        }
        catch (err) {
            res.status(500).json({ error: "Internal server error" });
        }
    });
    // Generate OTP secret (returns secret + QR code as base64 data URL)
    app.post("/api/admin/otp/setup", adminAuth, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const secret = generateOtpSecret();
            await db.setOtpSecret(secret);
            await db.setOtpEnabled(false);
            const otpauthUrl = buildOtpauthUrl(secret, config.adminUsername, buildUrl(config.domain, config.outPort));
            const QRCode = await import("qrcode");
            const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
                width: 200,
                margin: 2,
                color: { dark: "#1f2937", light: "#ffffff" },
            });
            // Return OTP secret in plaintext (admin already authenticated)
            res.json({ otpauthUrl, qrDataUrl, secret });
        }
        catch (err) {
            console.error('OTP setup error:', err);
            res.status(500).json({ error: "Failed to setup OTP" });
        }
    });
    // Verify & enable OTP
    app.post("/api/admin/otp/verify", adminAuth, csrfProtection, otpLimiter, async (req, res) => {
        try {
            const { code } = req.body;
            if (!code) {
                res.status(400).json({ error: "Missing OTP code" });
                return;
            }
            const secret = await db.getOtpSecret();
            if (!secret) {
                res.status(400).json({ error: "OTP not set up. Call /api/admin/otp/setup first." });
                return;
            }
            if (!verifyOtpToken(secret, code)) {
                res.status(403).json({ error: "Invalid OTP code" });
                return;
            }
            await db.setOtpEnabled(true);
            res.json({ success: true, message: "OTP enabled" });
        }
        catch (err) {
            console.error('OTP enable error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    // Disable OTP
    app.post("/api/admin/otp/disable", adminAuth, otpMiddleware, csrfProtection, adminLimiter, async (req, res) => {
        try {
            await db.setOtpEnabled(false);
            await db.setOtpSecret("");
            res.json({ success: true, message: "OTP disabled" });
        }
        catch (err) {
            console.error('OTP disable error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    // List all pages
    app.get("/api/admin/pages", adminAuth, otpMiddleware, adminLimiter, async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;
            const result = await db.listPages(limit, offset);
            // locked field is already included from database via rowToPage
            res.json({ pages: result.pages, total: result.total });
        }
        catch (err) {
            console.error('List pages error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    // Lock/unlock a page (prevents auto-cleanup)
    app.post("/api/admin/pages/:id/lock", adminAuth, otpMiddleware, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const { locked } = req.body;
            const page = await db.getPageById(req.params.id);
            if (!page) {
                res.status(404).json({ error: "Page not found" });
                return;
            }
            // Update locked status in database directly
            await db.updatePage(req.params.id, { locked: !!locked });
            res.json({ success: true, locked: !!locked });
        }
        catch (err) {
            console.error('Lock error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    app.get("/api/admin/pages/:id", adminAuth, otpMiddleware, adminLimiter, async (req, res) => {
        try {
            const page = await db.getPageById(req.params.id);
            if (!page) {
                res.status(404).json({ error: "Page not found" });
                return;
            }
            res.json(page);
        }
        catch (err) {
            console.error('Get page error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    app.put("/api/admin/pages/:id", adminAuth, otpMiddleware, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const { name, description } = req.body;
            const updated = await db.updatePage(req.params.id, { name, description });
            if (!updated) {
                res.status(404).json({ error: "Page not found" });
                return;
            }
            res.json(await db.getPageById(req.params.id));
        }
        catch (err) {
            console.error('Update page error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    app.delete("/api/admin/pages/:id", adminAuth, otpMiddleware, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const page = await db.getPageById(req.params.id);
            if (!page) {
                res.status(404).json({ error: "Page not found" });
                return;
            }
            storage.deletePage(page.shareId);
            await db.deletePage(req.params.id);
            res.json({ success: true });
        }
        catch (err) {
            console.error('Delete page error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    // Token Management
    app.get("/api/admin/tokens", adminAuth, otpMiddleware, adminLimiter, async (req, res) => {
        try {
            res.json({ tokens: await db.listTokens() });
        }
        catch (err) {
            console.error('List tokens error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    app.post("/api/admin/tokens", adminAuth, otpMiddleware, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const { name } = req.body;
            const now = new Date().toISOString();
            const token = { id: nanoid(), token: nanoid(32), name: name || `Token ${now.slice(0, 10)}`, createdAt: now };
            await db.createToken(token);
            res.status(201).json(token);
        }
        catch (err) {
            console.error('Create token error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    app.delete("/api/admin/tokens/:id", adminAuth, otpMiddleware, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const deleted = await db.deleteToken(req.params.id);
            if (!deleted) {
                res.status(404).json({ error: "Token not found" });
                return;
            }
            res.json({ success: true });
        }
        catch (err) {
            console.error('Delete token error:', err);
            res.status(500).json({ error: "Internal server error" });
        }
    });
    // ─── 5. Admin Dashboard (served at /) ────────────────────
    app.get("/", adminAuth, (req, res) => {
        const publicUrl = buildUrl(config.domain, config.outPort);
        // Inject domain URL into HTML
        const html = adminHtmlTemplate.replace('__DOMAIN_URL__', publicUrl);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src 'none'; object-src 'none'");
        res.send(html);
    });
    // Backward compat: /admin → /
    app.get("/admin", adminAuth, (_req, res) => {
        res.redirect(301, "/");
    });
    // ─── 6. Health check ─────────────────────────────────────
    app.get("/health", (_req, res) => {
        res.json({ status: "ok", timestamp: new Date().toISOString() });
    });
    return { app, db, storage };
}
//# sourceMappingURL=app.js.map