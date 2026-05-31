import express from "express";
import rateLimit from "express-rate-limit";
import mime from "mime-types";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import crypto from "crypto";
import { PagesDatabase } from "./db.js";
import { FileStorage } from "./storage.js";
import { bearerAuth, basicAuth } from "./auth.js";
import { buildUrl } from "../shared/types.js";
// ─── OTP helpers ────────────────────────────────────────────
function generateOtpSecret() {
    // Base32 encoded 20-byte random secret
    const bytes = crypto.randomBytes(20);
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let result = "";
    for (let i = 0; i < bytes.length; i++) {
        result += chars[bytes[i] % 32];
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
export function createApp(config) {
    const app = express();
    const db = new PagesDatabase(config.dbPath);
    const storage = new FileStorage(config.storagePath);
    // Load admin panel HTML template from external file
    // Resolve admin.html: works in both dev (ts-node) and prod (compiled JS)
    // Use process.cwd() as fallback since __dirname is not available in ESM
    const adminHtmlPath = path.resolve(process.cwd(), "server", "public", "admin.html");
    let adminHtmlTemplate = "";
    try {
        adminHtmlTemplate = fs.readFileSync(adminHtmlPath, "utf-8");
    }
    catch {
        console.error("Admin HTML template not found at", adminHtmlPath);
    }
    // ─── Body parsers ──────────────────────────────────────
    // Default: 1MB for most endpoints
    const defaultParser = express.json({ limit: "1mb" });
    // Deploy: 100MB for zip uploads
    const deployBodyParser = express.json({ limit: "100mb" });
    // Deploy routes need larger body — register BEFORE global default
    app.use("/api/deploy", deployBodyParser);
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
        max: 30,
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
    app.get("/s/:shareId", async (req, res) => {
        const { shareId } = req.params;
        // Validate shareId format (alphanumeric + hyphen only)
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
        const fullPath = path.join(pageDir, "index.html");
        // Ensure the resolved path is within the pageDir
        if (!path.resolve(fullPath).startsWith(pageDir + path.sep)) {
            res.status(403).send("<h1>403 - Forbidden</h1>");
            return;
        }
        if (!fs.existsSync(fullPath)) {
            res.status(404).send("<h1>404 - File not found</h1>");
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        // User-uploaded pages: allow scripts/styles since content is trusted (deployed by us)
        // script-src 'self' allows external JS from /s/:shareId/* (same page directory)
        // style-src 'unsafe-inline' allows <style> tags in the HTML
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src 'none'; object-src 'none'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-XSS-Protection", "1; mode=block");
        res.sendFile(fullPath);
    });
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
        // Additional safety: verify it's a file (not a directory) and exists
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
        // Sub-resources: allow same-origin CSS/JS/images (from the deployed page)
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.sendFile(fullPath);
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
            db.createPage({ id, shareId, name: name || `Page ${shareId}`, description, fileCount: result.fileCount, createdAt: now, updatedAt: now });
            const url = `${buildUrl(config.domain, config.outPort)}/s/${shareId}`;
            res.status(201).json({ id, shareId, url, name: name || `Page ${shareId}`, createdAt: now });
        }
        catch (err) {
            console.error('Deploy error:', err);
            res.status(500).json({ error: "Deploy failed" });
        }
    });
    // ─── 3. Admin Auth (Basic + optional OTP) ────────────────
    const adminAuth = basicAuth(config.adminUsername, config.adminPassword);
    // OTP middleware — checks if OTP is enabled, if so requires valid code
    const otpMiddleware = async (req, res, next) => {
        const otpEnabled = await db.getOtpEnabled();
        if (!otpEnabled) {
            next();
            return;
        }
        const otpHeader = req.headers["x-otp-code"];
        if (!otpHeader || typeof otpHeader !== "string") {
            res.status(401).json({ error: "OTP required", otpRequired: true });
            return;
        }
        const secret = await db.getOtpSecret();
        if (!secret || !verifyOtpToken(secret, otpHeader)) {
            res.status(403).json({ error: "Invalid OTP code" });
            return;
        }
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
    // ─── OTP Secret Decrypt ───────────────────────────────
    app.post("/api/admin/otp/decrypt", adminAuth, csrfProtection, adminLimiter, async (req, res) => {
        try {
            const { encSecret, token } = req.body;
            if (!encSecret || !token) {
                res.status(400).json({ error: "Missing parameters" });
                return;
            }
            const tokenStore = globalThis._otpDecryptTokens;
            if (!tokenStore || !tokenStore.has(token)) {
                res.status(403).json({ error: "Invalid or expired decrypt token" });
                return;
            }
            const tokenData = tokenStore.get(token);
            if (tokenData.expiry < Date.now()) {
                tokenStore.delete(token);
                res.status(403).json({ error: "Decrypt token expired" });
                return;
            }
            const parts = encSecret.split(":");
            if (parts.length !== 3) {
                res.status(400).json({ error: "Invalid encrypted secret format" });
                return;
            }
            const encKey = crypto.createHash("sha256").update(config.adminPassword + "-otp-enc").digest();
            const iv = Buffer.from(parts[0], "hex");
            const authTag = Buffer.from(parts[1], "hex");
            const encrypted = Buffer.from(parts[2], "hex");
            const decipher = crypto.createDecipheriv("aes-256-gcm", encKey, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encrypted).toString("utf8");
            decrypted += decipher.final("utf8");
            tokenStore.delete(token);
            res.json({ secret: decrypted });
        }
        catch (err) {
            console.error('OTP decrypt error:', err);
            res.status(500).json({ error: "Decryption failed" });
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
            // Encrypt OTP secret before sending (defense in depth)
            const encKey = crypto.createHash("sha256").update(config.adminPassword + "-otp-enc").digest();
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv("aes-256-gcm", encKey, iv);
            let encrypted = cipher.update(secret, "utf8", "hex");
            encrypted += cipher.final("hex");
            const authTag = cipher.getAuthTag().toString("hex");
            res.json({ otpauthUrl, qrDataUrl, encSecret: iv.toString("hex") + ":" + authTag + ":" + encrypted });
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
            res.json({ pages: result.pages, total: result.total });
        }
        catch (err) {
            console.error('List pages error:', err);
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
    app.get("/", adminAuth, otpMiddleware, (req, res) => {
        // Generate a short-lived OTP decrypt token
        // This token allows the frontend to decrypt OTP secrets without exposing the admin password
        const decryptToken = crypto.randomBytes(32).toString("hex");
        const tokenExpiry = Date.now() + 5 * 60 * 1000; // 5 minutes
        // Store in memory (in production, use a proper cache with TTL)
        if (!globalThis._otpDecryptTokens)
            globalThis._otpDecryptTokens = new Map();
        globalThis._otpDecryptTokens.set(decryptToken, { expiry: tokenExpiry, adminUser: config.adminUsername });
        // Clean old tokens periodically
        if (globalThis._otpDecryptTokens.size > 1000) {
            const now = Date.now();
            for (const [k, v] of globalThis._otpDecryptTokens) {
                if (v.expiry < now)
                    globalThis._otpDecryptTokens.delete(k);
            }
        }
        const publicUrl = buildUrl(config.domain, config.outPort);
        // Set decrypt token as httpOnly cookie (not accessible via JS, prevents XSS theft)
        res.cookie('otp_decrypt', decryptToken, {
            httpOnly: true,
            secure: config.domain.startsWith('https'),
            sameSite: 'strict',
            maxAge: 5 * 60 * 1000, // 5 minutes
            path: '/api/admin/otp',
        });
        // Inject only domain URL into HTML
        let html = adminHtmlTemplate.replace('__DOMAIN_URL__', publicUrl);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
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