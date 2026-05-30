import express from "express";
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
    // ─── Global middleware ───────────────────────────────────
    app.use(express.json({ limit: "50mb" }));
    app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        if (req.method === "OPTIONS") {
            res.sendStatus(204);
            return;
        }
        next();
    });
    // ─── 1. Static page serving: /s/:shareId ─────────────────
    app.get("/s/:shareId", async (req, res) => {
        const { shareId } = req.params;
        const page = await db.getPageByShareId(shareId);
        if (!page) {
            res.status(404).send("<h1>404 - Page not found</h1>");
            return;
        }
        const pageDir = path.join(config.storagePath, shareId);
        const fullPath = path.join(pageDir, "index.html");
        if (!fs.existsSync(fullPath)) {
            res.status(404).send("<h1>404 - File not found</h1>");
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.sendFile(fullPath);
    });
    app.get("/s/:shareId/*", async (req, res) => {
        const { shareId } = req.params;
        const page = await db.getPageByShareId(shareId);
        if (!page) {
            res.status(404).send("<h1>404 - Page not found</h1>");
            return;
        }
        const pageDir = path.join(config.storagePath, shareId);
        const subPath = req.params[0] || "";
        const safePath = path.normalize(subPath).replace(/^(\.\.(\/|\\|$))+/, "");
        const fullPath = path.join(pageDir, safePath);
        if (!fullPath.startsWith(pageDir)) {
            res.status(403).send("<h1>403 - Forbidden</h1>");
            return;
        }
        if (!fs.existsSync(fullPath)) {
            res.status(404).send("<h1>404 - File not found</h1>");
            return;
        }
        const mimeType = mime.lookup(fullPath) || "application/octet-stream";
        res.setHeader("Content-Type", mimeType);
        res.sendFile(fullPath);
    });
    // ─── 2. Deploy API (Bearer token) ────────────────────────
    const deployAuth = bearerAuth(db);
    app.post("/api/deploy/html", deployAuth, (req, res) => {
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
            const url = `${buildUrl(config.domain, config.port)}/s/${shareId}`;
            res.status(201).json({ id, shareId, url, name: name || `Page ${shareId}`, createdAt: now });
        }
        catch (err) {
            res.status(500).json({ error: "Deploy failed", message: err.message });
        }
    });
    app.post("/api/deploy/folder", deployAuth, (req, res) => {
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
            const url = `${buildUrl(config.domain, config.port)}/s/${shareId}`;
            res.status(201).json({ id, shareId, url, name: name || `Page ${shareId}`, createdAt: now });
        }
        catch (err) {
            res.status(500).json({ error: "Deploy failed", message: err.message });
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
    // ─── 4. Admin API ────────────────────────────────────────
    // OTP status
    app.get("/api/admin/otp/status", adminAuth, async (req, res) => {
        try {
            const enabled = await db.getOtpEnabled();
            const hasSecret = !!(await db.getOtpSecret());
            res.json({ enabled, hasSecret });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // Generate OTP secret (returns secret + otpauth URL for QR code)
    app.post("/api/admin/otp/setup", adminAuth, async (req, res) => {
        try {
            const secret = generateOtpSecret();
            await db.setOtpSecret(secret);
            await db.setOtpEnabled(false); // Not enabled until verified
            const url = buildOtpauthUrl(secret, config.adminUsername, buildUrl(config.domain, config.port));
            res.json({ secret, otpauthUrl: url });
        }
        catch (err) {
            res.status(500).json({ error: "Failed to setup OTP", message: err.message });
        }
    });
    // Verify & enable OTP
    app.post("/api/admin/otp/verify", adminAuth, async (req, res) => {
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
            res.status(500).json({ error: err.message });
        }
    });
    // Disable OTP
    app.post("/api/admin/otp/disable", adminAuth, otpMiddleware, async (req, res) => {
        try {
            await db.setOtpEnabled(false);
            await db.setOtpSecret("");
            res.json({ success: true, message: "OTP disabled" });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // List all pages
    app.get("/api/admin/pages", adminAuth, otpMiddleware, async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;
            const result = await db.listPages(limit, offset);
            res.json({ pages: result.pages, total: result.total });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    app.get("/api/admin/pages/:id", adminAuth, otpMiddleware, async (req, res) => {
        try {
            const page = await db.getPageById(req.params.id);
            if (!page) {
                res.status(404).json({ error: "Page not found" });
                return;
            }
            res.json(page);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    app.put("/api/admin/pages/:id", adminAuth, otpMiddleware, async (req, res) => {
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
            res.status(500).json({ error: err.message });
        }
    });
    app.delete("/api/admin/pages/:id", adminAuth, otpMiddleware, async (req, res) => {
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
            res.status(500).json({ error: err.message });
        }
    });
    // Token Management
    app.get("/api/admin/tokens", adminAuth, otpMiddleware, async (req, res) => {
        try {
            res.json({ tokens: await db.listTokens() });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post("/api/admin/tokens", adminAuth, otpMiddleware, async (req, res) => {
        try {
            const { name } = req.body;
            const now = new Date().toISOString();
            const token = { id: nanoid(), token: nanoid(32), name: name || `Token ${now.slice(0, 10)}`, createdAt: now };
            await db.createToken(token);
            res.status(201).json(token);
        }
        catch (err) {
            res.status(500).json({ error: "Failed to create token", message: err.message });
        }
    });
    app.delete("/api/admin/tokens/:id", adminAuth, otpMiddleware, async (req, res) => {
        try {
            const deleted = await db.deleteToken(req.params.id);
            if (!deleted) {
                res.status(404).json({ error: "Token not found" });
                return;
            }
            res.json({ success: true });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // ─── 5. Admin Dashboard (served at /) ────────────────────
    app.get("/", adminAuth, otpMiddleware, (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(getAdminHtml(config));
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
// ─── Admin Dashboard HTML ───────────────────────────────────
function getAdminHtml(config) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pages MCP Admin</title>
  <style>
    /* ─── Theme Variables ─────────────────────────────────── */
    :root {
      --bg: #f5f5f5; --bg2: white; --bg3: #fafafa; --bg4: #f9fafb;
      --text: #333; --text2: #666; --text3: #888; --text4: #999;
      --border: #eee; --border2: #f0f0f0; --border3: #ddd;
      --accent: #667eea; --accent2: #5a6fd6;
      --green: #059669; --green-bg: #ecfdf5;
      --red: #dc2626; --red-bg: #fee2e2;
      --blue: #6366f1; --blue-bg: #eef2ff;
      --shadow: 0 1px 3px rgba(0,0,0,0.1);
      --header-bg: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    [data-theme="dark"] {
      --bg: #0f172a; --bg2: #1e293b; --bg3: #1e293b; --bg4: #334155;
      --text: #e2e8f0; --text2: #94a3b8; --text3: #64748b; --text4: #475569;
      --border: #334155; --border2: #1e293b; --border3: #475569;
      --accent: #818cf8; --accent2: #6366f1;
      --green: #34d399; --green-bg: rgba(52,211,153,0.1);
      --red: #f87171; --red-bg: rgba(248,113,113,0.1);
      --blue: #818cf8; --blue-bg: rgba(129,140,248,0.1);
      --shadow: 0 1px 3px rgba(0,0,0,0.3);
      --header-bg: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); transition: background 0.2s, color 0.2s; }
    .header { background: var(--header-bg); color: white; padding: 24px 32px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 24px; font-weight: 600; }
    .header p { opacity: 0.85; margin-top: 4px; font-size: 14px; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--bg2); border-radius: 12px; padding: 20px; box-shadow: var(--shadow); }
    .stat-card .label { font-size: 13px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .card { background: var(--bg2); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; margin-bottom: 24px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); }
    .card-header h2 { font-size: 18px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 12px 20px; background: var(--bg3); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text3); border-bottom: 1px solid var(--border); }
    td { padding: 12px 20px; border-bottom: 1px solid var(--border2); font-size: 14px; }
    tr:hover { background: var(--bg3); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
    .badge-blue { background: var(--blue-bg); color: var(--blue); }
    .badge-green { background: var(--green-bg); color: var(--green); }
    .badge-red { background: var(--red-bg); color: var(--red); }
    .btn { display: inline-block; padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; border: none; }
    .btn-danger { background: var(--red-bg); color: var(--red); }
    .btn-danger:hover { filter: brightness(0.9); }
    .btn-edit { background: var(--blue-bg); color: var(--blue); margin-right: 6px; }
    .btn-edit:hover { filter: brightness(0.9); }
    .btn-primary { background: var(--accent); color: white; padding: 8px 20px; }
    .btn-primary:hover { background: var(--accent2); }
    .btn-cancel { background: var(--bg4); color: var(--text2); padding: 8px 20px; }
    .btn-cancel:hover { filter: brightness(0.9); }
    .btn-success { background: var(--green-bg); color: var(--green); }
    .btn-success:hover { filter: brightness(0.9); }
    .empty { text-align: center; padding: 40px 20px; color: var(--text4); }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 100; justify-content: center; align-items: center; }
    .modal-overlay.active { display: flex; }
    .modal { background: var(--bg2); border-radius: 12px; padding: 32px; width: 520px; max-width: 90%; max-height: 90vh; overflow-y: auto; }
    .modal h2 { margin-bottom: 20px; }
    .modal h3 { margin: 16px 0 8px; font-size: 15px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; }
    .form-group input, .form-group textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--border3); border-radius: 8px; font-size: 14px; background: var(--bg2); color: var(--text); }
    .form-group textarea { resize: vertical; min-height: 80px; }
    .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
    .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px; color: white; font-size: 14px; z-index: 200; transition: opacity 0.3s; }
    .toast-success { background: #10b981; }
    .toast-error { background: #ef4444; }
    .token-cell { display: flex; align-items: center; gap: 8px; }
    .token-cell code { background: var(--bg4); padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer; user-select: all; }
    .token-cell code:hover { filter: brightness(0.9); }
    .token-cell .copy-hint { font-size: 11px; color: var(--text4); }
    .otp-status { display: flex; align-items: center; gap: 8px; }
    .otp-qr { text-align: center; padding: 16px; background: var(--bg4); border-radius: 8px; margin: 12px 0; }
    .otp-qr img { max-width: 200px; }
    .otp-secret { font-family: monospace; font-size: 14px; background: var(--bg4); padding: 8px 12px; border-radius: 6px; word-break: break-all; margin: 8px 0; }
    .step { margin: 12px 0; padding: 12px; background: var(--bg4); border-radius: 8px; }
    .step-num { display: inline-block; width: 24px; height: 24px; background: var(--accent); color: white; border-radius: 50%; text-align: center; line-height: 24px; font-size: 13px; margin-right: 8px; }
    /* ─── Theme Switcher ──────────────────────────────────── */
    .theme-btn { background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.3); color: white; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-right: 8px; }
    .theme-btn:hover { background: rgba(255,255,255,0.3); }
    .theme-btn.active { background: rgba(255,255,255,0.35); border-color: rgba(255,255,255,0.5); }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>🚀 Pages MCP Admin</h1>
      <p>Manage your deployed static pages &amp; API tokens</p>
    </div>
    <div class="otp-status">
      <span id="otpBadge"></span>
      <button class="btn btn-primary" onclick="openOtpModal()">🔐 2FA</button>
      <div style="display:flex;gap:4px;margin-left:8px;">
        <button class="theme-btn" id="themeAuto" onclick="setTheme('auto')" title="Follow system">🌓 Auto</button>
        <button class="theme-btn" id="themeLight" onclick="setTheme('light')" title="Light mode">☀️</button>
        <button class="theme-btn" id="themeDark" onclick="setTheme('dark')" title="Dark mode">🌙</button>
      </div>
    </div>
  </div>
  <div class="container">
    <div class="stats">
      <div class="stat-card"><div class="label">Total Pages</div><div class="value" id="totalPages">-</div></div>
      <div class="stat-card"><div class="label">API Tokens</div><div class="value" id="totalTokens">-</div></div>
      <div class="stat-card"><div class="label">2FA</div><div class="value" id="otpStatus" style="font-size:18px;margin-top:8px;">-</div></div>
      <div class="stat-card"><div class="label">Domain</div><div class="value" style="font-size:14px;margin-top:8px;word-break:break-all;">${buildUrl(config.domain, config.port)}</div></div>
    </div>

    <!-- Pages -->
    <div class="card">
      <div class="card-header"><h2>📄 Deployed Pages</h2></div>
      <table>
        <thead><tr><th>Name</th><th>Share URL</th><th>Files</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody id="pageTable"></tbody>
      </table>
      <div class="empty" id="emptyState" style="display:none;">No pages deployed yet.</div>
    </div>

    <!-- Tokens -->
    <div class="card">
      <div class="card-header"><h2>🔑 API Tokens</h2><button class="btn btn-primary" onclick="createToken()">+ New Token</button></div>
      <table>
        <thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Last Used</th><th>Actions</th></tr></thead>
        <tbody id="tokenTable"></tbody>
      </table>
      <div class="empty" id="emptyTokens" style="display:none;">No API tokens yet. Create one to use the MCP / Deploy API.</div>
    </div>
  </div>

  <!-- Edit Modal -->
  <div class="modal-overlay" id="editModal"><div class="modal">
    <h2>Edit Page</h2>
    <div class="form-group"><label>Name</label><input type="text" id="editName" /></div>
    <div class="form-group"><label>Description</label><textarea id="editDescription"></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-cancel" onclick="closeModal('editModal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveEdit()">Save</button>
    </div>
  </div></div>

  <!-- Token Created Modal -->
  <div class="modal-overlay" id="tokenModal"><div class="modal">
    <h2>✅ Token Created</h2>
    <p style="margin-bottom:12px;color:#666;">Copy this token now. It won't be shown again.</p>
    <div class="otp-secret" id="newTokenValue" style="font-size:16px;text-align:center;cursor:pointer;" onclick="copyEl(this)"></div>
    <div style="text-align:center;"><span class="copy-hint">👆 Click to copy</span></div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="closeModal('tokenModal')">Done</button></div>
  </div></div>

  <!-- OTP Modal -->
  <div class="modal-overlay" id="otpModal"><div class="modal">
    <h2>🔐 Two-Factor Authentication</h2>
    <div id="otpContent"></div>
    <div class="modal-actions"><button class="btn btn-cancel" onclick="closeModal('otpModal')">Close</button></div>
  </div></div>

  <script>
    let pages = [], tokens = [], editingId = null, otpEnabled = false;

    async function api(path, opts = {}) {
      const res = await fetch(path, { headers: { 'Content-Type': 'application/json', ...opts.headers }, ...opts });
      const data = await res.json();
      if (data.otpRequired) { openOtpModal(); return null; }
      return data;
    }

    async function loadPages() {
      const data = await api('/api/admin/pages');
      if (!data) return;
      pages = data.pages || [];
      document.getElementById('totalPages').textContent = data.total || 0;
      renderTable();
    }

    async function loadTokens() {
      const data = await api('/api/admin/tokens');
      if (!data) return;
      tokens = data.tokens || [];
      document.getElementById('totalTokens').textContent = tokens.length;
      renderTokenTable();
    }

    async function loadOtpStatus() {
      const data = await api('/api/admin/otp/status');
      if (!data) return;
      otpEnabled = data.enabled;
      document.getElementById('otpStatus').innerHTML = data.enabled
        ? '<span class="badge badge-green">Enabled</span>'
        : '<span class="badge badge-red">Disabled</span>';
      document.getElementById('otpBadge').innerHTML = data.enabled
        ? '<span class="badge badge-green">🔒 2FA On</span>'
        : '';
    }

    function renderTable() {
      const tbody = document.getElementById('pageTable');
      const empty = document.getElementById('emptyState');
      if (!pages.length) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
      empty.style.display = 'none';
      tbody.innerHTML = pages.map(p => {
        const url = '${buildUrl(config.domain, config.port)}/s/' + p.shareId;
        return \`<tr>
          <td><strong>\${esc(p.name)}</strong>\${p.description ? '<br><small style=\\"color:#888\\">'+esc(p.description)+'</small>' : ''}</td>
          <td><a href="\${url}" target="_blank">/s/\${p.shareId}</a></td>
          <td><span class="badge badge-blue">\${p.fileCount}</span></td>
          <td>\${new Date(p.createdAt).toLocaleDateString()}</td>
          <td><button class="btn btn-edit" onclick="openEdit('\${p.id}')">Edit</button><button class="btn btn-danger" onclick="deletePage('\${p.id}')">Delete</button></td>
        </tr>\`;
      }).join('');
    }

    function renderTokenTable() {
      const tbody = document.getElementById('tokenTable');
      const empty = document.getElementById('emptyTokens');
      if (!tokens.length) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
      empty.style.display = 'none';
      tbody.innerHTML = tokens.map(t => {
        return \`<tr>
          <td><strong>\${esc(t.name)}</strong></td>
          <td><div class="token-cell"><code onclick="copyText('\${t.token}')" title="Click to copy full token">\${t.token}</code></div></td>
          <td>\${new Date(t.createdAt).toLocaleDateString()}</td>
          <td>\${t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : '-'}</td>
          <td><button class="btn btn-danger" onclick="deleteToken('\${t.id}')">Delete</button></td>
        </tr>\`;
      }).join('');
    }

    function copyText(t) { navigator.clipboard.writeText(t).then(() => showToast('Copied!', 'success')); }
    function copyEl(el) { copyText(el.textContent.trim()); }

    async function createToken() {
      const name = prompt('Token name (optional):');
      if (name === null) return;
      const data = await api('/api/admin/tokens', { method: 'POST', body: JSON.stringify({ name }) });
      if (!data) return;
      document.getElementById('newTokenValue').textContent = data.token;
      document.getElementById('tokenModal').classList.add('active');
      loadTokens();
    }

    async function deleteToken(id) {
      if (!confirm('Delete this token?')) return;
      await api('/api/admin/tokens/' + id, { method: 'DELETE' });
      showToast('Token deleted', 'success');
      loadTokens();
    }

    function openEdit(id) {
      const p = pages.find(x => x.id === id);
      if (!p) return;
      editingId = id;
      document.getElementById('editName').value = p.name;
      document.getElementById('editDescription').value = p.description || '';
      document.getElementById('editModal').classList.add('active');
    }

    function closeModal(id) { document.getElementById(id).classList.remove('active'); }

    async function saveEdit() {
      await api('/api/admin/pages/' + editingId, { method: 'PUT', body: JSON.stringify({ name: document.getElementById('editName').value, description: document.getElementById('editDescription').value }) });
      closeModal('editModal');
      showToast('Page updated', 'success');
      loadPages();
    }

    async function deletePage(id) {
      if (!confirm('Delete this page? This cannot be undone.')) return;
      await api('/api/admin/pages/' + id, { method: 'DELETE' });
      showToast('Page deleted', 'success');
      loadPages();
    }

    // ─── OTP ──────────────────────────────────────────────
    async function openOtpModal() {
      const data = await api('/api/admin/otp/status');
      if (!data) return;
      const content = document.getElementById('otpContent');
      if (data.enabled) {
        content.innerHTML = \`
          <p><span class="badge badge-green">✓ 2FA Enabled</span></p>
          <p style="margin:12px 0;color:#666;">Two-factor authentication is active. You'll need your authenticator app to access the admin panel.</p>
          <button class="btn btn-danger" onclick="disableOtp()">Disable 2FA</button>
        \`;
      } else if (data.hasSecret) {
        content.innerHTML = \`
          <p><span class="badge badge-red">Setup incomplete</span></p>
          <div class="step"><span class="step-num">1</span> Scan the QR code below with Google Authenticator or similar app.</div>
          <div class="otp-qr"><img id="otpQrImg" /></div>
          <div class="step"><span class="step-num">2</span> Enter the 6-digit code from your app to verify.</div>
          <div class="form-group"><input type="text" id="otpVerifyCode" placeholder="000000" maxlength="6" style="text-align:center;font-size:24px;letter-spacing:8px;" /></div>
          <button class="btn btn-success" onclick="verifyOtp()">Verify &amp; Enable</button>
          <button class="btn btn-cancel" onclick="resetOtp()" style="margin-left:8px;">Start Over</button>
        \`;
        await showOtpQr();
      } else {
        content.innerHTML = \`
          <p><span class="badge badge-red">2FA Disabled</span></p>
          <p style="margin:12px 0;color:#666;">Enable two-factor authentication to secure your admin panel. You'll need Google Authenticator or a similar TOTP app.</p>
          <button class="btn btn-success" onclick="setupOtp()">Setup 2FA</button>
        \`;
      }
      document.getElementById('otpModal').classList.add('active');
    }

    async function setupOtp() {
      const data = await api('/api/admin/otp/setup', { method: 'POST', body: '{}' });
      if (!data) return;
      openOtpModal(); // Re-open to show QR
    }

    async function showOtpQr() {
      const status = await api('/api/admin/otp/status');
      if (!status || !status.hasSecret) return;
      // Get the otpauth URL by calling setup again (returns existing secret)
      const data = await api('/api/admin/otp/setup', { method: 'POST', body: '{}' });
      if (!data) return;
      // Generate QR code using a public API
      const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(data.otpauthUrl);
      document.getElementById('otpQrImg').src = qrUrl;
      // Show secret for manual entry
      const content = document.getElementById('otpContent');
      content.innerHTML += \`<p style="margin-top:8px;font-size:12px;color:#888;">Can't scan? Enter manually: <code>\${data.secret}</code></p>\`;
    }

    async function verifyOtp() {
      const code = document.getElementById('otpVerifyCode').value.trim();
      if (!code || code.length !== 6) { showToast('Enter a 6-digit code', 'error'); return; }
      const res = await fetch('/api/admin/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      const data = await res.json();
      if (data.success) {
        showToast('2FA enabled!', 'success');
        closeModal('otpModal');
        loadOtpStatus();
      } else {
        showToast(data.error || 'Invalid code', 'error');
      }
    }

    async function disableOtp() {
      if (!confirm('Disable 2FA? Your admin panel will only use password.')) return;
      // Need current OTP to disable
      const code = prompt('Enter current 6-digit OTP code to confirm:');
      if (!code) return;
      const res = await fetch('/api/admin/otp/disable', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OTP-Code': code }, body: '{}' });
      const data = await res.json();
      if (data.success) {
        showToast('2FA disabled', 'success');
        closeModal('otpModal');
        loadOtpStatus();
      } else {
        showToast(data.error || 'Failed', 'error');
      }
    }

    async function resetOtp() {
      // Just re-setup (generates new secret)
      await setupOtp();
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function showToast(msg, type) {
      const t = document.createElement('div');
      t.className = 'toast toast-' + type;
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2500);
    }

    // ─── Theme ────────────────────────────────────────────
    function applyTheme(t) {
      if (t === 'dark') { document.documentElement.setAttribute('data-theme','dark'); }
      else if (t === 'light') { document.documentElement.removeAttribute('data-theme'); }
      else { // auto
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        if (mq.matches) document.documentElement.setAttribute('data-theme','dark');
        else document.documentElement.removeAttribute('data-theme');
      }
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      const btn = document.getElementById('theme' + t.charAt(0).toUpperCase() + t.slice(1));
      if (btn) btn.classList.add('active');
    }
    function setTheme(t) {
      localStorage.setItem('theme', t);
      applyTheme(t);
    }
    // Listen for system theme changes in auto mode
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (localStorage.getItem('theme') === 'auto' || !localStorage.getItem('theme')) applyTheme('auto');
    });
    // Init theme from saved preference or default to auto
    applyTheme(localStorage.getItem('theme') || 'auto');

    loadPages(); loadTokens(); loadOtpStatus();
  </script>
</body>
</html>`;
}
//# sourceMappingURL=app.js.map