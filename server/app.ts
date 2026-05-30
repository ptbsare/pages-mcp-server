import express, { Request, Response } from "express";
import mime from "mime-types";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import crypto from "crypto";
import { PagesDatabase } from "./db.js";
import { FileStorage } from "./storage.js";
import { bearerAuth, basicAuth } from "./auth.js";
import type {
  ServerConfig,
  DeployedPage,
  DeployResponse,
  ListPagesResponse,
  AuthToken,
  ErrorResponse,
} from "../shared/types.js";
import { buildUrl } from "../shared/types.js";

// ─── OTP helpers ────────────────────────────────────────────
function generateOtpSecret(): string {
  // Base32 encoded 20-byte random secret
  const bytes = crypto.randomBytes(20);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += chars[bytes[i] % 32];
  }
  return result;
}

function base32Decode(input: string): Buffer {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.replace(/\s/g, "").toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const c of cleaned) {
    const val = chars.indexOf(c);
    if (val === -1) continue;
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function verifyOtpToken(secret: string, token: string): boolean {
  const STEP = 30;
  const now = Math.floor(Date.now() / 1000);
  const key = base32Decode(secret);
  for (let offset = -1; offset <= 1; offset++) {
    const counter = Math.floor((now + offset * STEP) / STEP);
    const buf = Buffer.alloc(8);
    let tmp = counter;
    for (let i = 7; i >= 0; i--) { buf[i] = tmp & 0xff; tmp = Math.floor(tmp / 256); }
    const hmac = crypto.createHmac("sha1", key);
    hmac.update(buf);
    const digest = hmac.digest();
    const o = digest[digest.length - 1] & 0x0f;
    const code = ((digest[o] & 0x7f) << 24 | (digest[o + 1] & 0xff) << 16 | (digest[o + 2] & 0xff) << 8 | (digest[o + 3] & 0xff)) % 1000000;
    if (code.toString().padStart(6, "0") === token) return true;
  }
  return false;
}

function buildOtpauthUrl(secret: string, username: string, domain: string): string {
  return `otpauth://totp/${encodeURIComponent(domain)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(domain)}`;
}

export function createApp(config: ServerConfig) {
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
  app.get("/s/:shareId", async (req: Request, res: Response) => {
    const { shareId } = req.params;
    const page = await db.getPageByShareId(shareId);
    if (!page) { res.status(404).send("<h1>404 - Page not found</h1>"); return; }
    const pageDir = path.join(config.storagePath, shareId);
    const fullPath = path.join(pageDir, "index.html");
    if (!fs.existsSync(fullPath)) { res.status(404).send("<h1>404 - File not found</h1>"); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.sendFile(fullPath);
  });

  app.get("/s/:shareId/*", async (req: Request, res: Response) => {
    const { shareId } = req.params;
    const page = await db.getPageByShareId(shareId);
    if (!page) { res.status(404).send("<h1>404 - Page not found</h1>"); return; }
    const pageDir = path.join(config.storagePath, shareId);
    const subPath = req.params[0] || "";
    const safePath = path.normalize(subPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const fullPath = path.join(pageDir, safePath);
    if (!fullPath.startsWith(pageDir)) { res.status(403).send("<h1>403 - Forbidden</h1>"); return; }
    if (!fs.existsSync(fullPath)) { res.status(404).send("<h1>404 - File not found</h1>"); return; }
    const mimeType = mime.lookup(fullPath) || "application/octet-stream";
    res.setHeader("Content-Type", mimeType);
    res.sendFile(fullPath);
  });

  // ─── 2. Deploy API (Bearer token) ────────────────────────
  const deployAuth = bearerAuth(db);

  app.post("/api/deploy/html", deployAuth, (req: Request, res: Response) => {
    try {
      const { value, name, description } = req.body;
      if (!value || typeof value !== "string") {
        res.status(400).json({ error: "Missing or invalid 'value' field" } as ErrorResponse); return;
      }
      const shareId = nanoid(12);
      const id = nanoid();
      const now = new Date().toISOString();
      storage.storeHtml(shareId, value);
      db.createPage({ id, shareId, name: name || `Page ${shareId}`, description, fileCount: 1, createdAt: now, updatedAt: now });
      const url = `${buildUrl(config.domain, config.port)}/s/${shareId}`;
      res.status(201).json({ id, shareId, url, name: name || `Page ${shareId}`, createdAt: now });
    } catch (err: any) {
      res.status(500).json({ error: "Deploy failed", message: err.message } as ErrorResponse);
    }
  });

  app.post("/api/deploy/folder", deployAuth, (req: Request, res: Response) => {
    try {
      const { zipBase64, name, description } = req.body;
      if (!zipBase64 || typeof zipBase64 !== "string") {
        res.status(400).json({ error: "Missing or invalid 'zipBase64' field" } as ErrorResponse); return;
      }
      const shareId = nanoid(12);
      const id = nanoid();
      const now = new Date().toISOString();
      const result = storage.storeZip(shareId, zipBase64);
      db.createPage({ id, shareId, name: name || `Page ${shareId}`, description, fileCount: result.fileCount, createdAt: now, updatedAt: now });
      const url = `${buildUrl(config.domain, config.port)}/s/${shareId}`;
      res.status(201).json({ id, shareId, url, name: name || `Page ${shareId}`, createdAt: now });
    } catch (err: any) {
      res.status(500).json({ error: "Deploy failed", message: err.message } as ErrorResponse);
    }
  });

  // ─── 3. Admin Auth (Basic + optional OTP) ────────────────
  const adminAuth = basicAuth(config.adminUsername, config.adminPassword);

  // OTP middleware — checks if OTP is enabled, if so requires valid code
  const otpMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const otpEnabled = await db.getOtpEnabled();
    if (!otpEnabled) { next(); return; }
    const otpHeader = req.headers["x-otp-code"];
    if (!otpHeader || typeof otpHeader !== "string") {
      res.status(401).json({ error: "OTP required", otpRequired: true } as ErrorResponse);
      return;
    }
    const secret = await db.getOtpSecret();
    if (!secret || !verifyOtpToken(secret, otpHeader)) {
      res.status(403).json({ error: "Invalid OTP code" } as ErrorResponse);
      return;
    }
    next();
  };

  // ─── 4. Admin API ────────────────────────────────────────

  // OTP status
  app.get("/api/admin/otp/status", adminAuth, async (req: Request, res: Response) => {
    try {
      const enabled = await db.getOtpEnabled();
      const hasSecret = !!(await db.getOtpSecret());
      res.json({ enabled, hasSecret });
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  // Generate OTP secret (returns secret + QR code as base64 data URL)
  app.post("/api/admin/otp/setup", adminAuth, async (req: Request, res: Response) => {
    try {
      const secret = generateOtpSecret();
      await db.setOtpSecret(secret);
      await db.setOtpEnabled(false);
      const otpauthUrl = buildOtpauthUrl(secret, config.adminUsername, buildUrl(config.domain, config.port));
      // Generate QR code locally as base64 PNG
      const QRCode = await import("qrcode");
      const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
        width: 200,
        margin: 2,
        color: { dark: "#1f2937", light: "#ffffff" },
      });
      res.json({ secret, otpauthUrl, qrDataUrl });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to setup OTP", message: err.message } as ErrorResponse);
    }
  });

  // Verify & enable OTP
  app.post("/api/admin/otp/verify", adminAuth, async (req: Request, res: Response) => {
    try {
      const { code } = req.body;
      if (!code) { res.status(400).json({ error: "Missing OTP code" } as ErrorResponse); return; }
      const secret = await db.getOtpSecret();
      if (!secret) { res.status(400).json({ error: "OTP not set up. Call /api/admin/otp/setup first." } as ErrorResponse); return; }
      if (!verifyOtpToken(secret, code)) {
        res.status(403).json({ error: "Invalid OTP code" } as ErrorResponse); return;
      }
      await db.setOtpEnabled(true);
      res.json({ success: true, message: "OTP enabled" });
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  // Disable OTP
  app.post("/api/admin/otp/disable", adminAuth, otpMiddleware, async (req: Request, res: Response) => {
    try {
      await db.setOtpEnabled(false);
      await db.setOtpSecret("");
      res.json({ success: true, message: "OTP disabled" });
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  // List all pages
  app.get("/api/admin/pages", adminAuth, otpMiddleware, async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const result = await db.listPages(limit, offset);
      res.json({ pages: result.pages, total: result.total });
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  app.get("/api/admin/pages/:id", adminAuth, otpMiddleware, async (req: Request, res: Response) => {
    try {
      const page = await db.getPageById(req.params.id);
      if (!page) { res.status(404).json({ error: "Page not found" } as ErrorResponse); return; }
      res.json(page);
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  app.put("/api/admin/pages/:id", adminAuth, otpMiddleware, async (req: Request, res: Response) => {
    try {
      const { name, description } = req.body;
      const updated = await db.updatePage(req.params.id, { name, description });
      if (!updated) { res.status(404).json({ error: "Page not found" } as ErrorResponse); return; }
      res.json(await db.getPageById(req.params.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  app.delete("/api/admin/pages/:id", adminAuth, otpMiddleware, async (req: Request, res: Response) => {
    try {
      const page = await db.getPageById(req.params.id);
      if (!page) { res.status(404).json({ error: "Page not found" } as ErrorResponse); return; }
      storage.deletePage(page.shareId);
      await db.deletePage(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  // Token Management
  app.get("/api/admin/tokens", adminAuth, otpMiddleware, async (req: Request, res: Response) => {
    try {
      res.json({ tokens: await db.listTokens() });
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  app.post("/api/admin/tokens", adminAuth, otpMiddleware, async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      const now = new Date().toISOString();
      const token: AuthToken = { id: nanoid(), token: nanoid(32), name: name || `Token ${now.slice(0, 10)}`, createdAt: now };
      await db.createToken(token);
      res.status(201).json(token);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to create token", message: err.message } as ErrorResponse);
    }
  });

  app.delete("/api/admin/tokens/:id", adminAuth, otpMiddleware, async (req: Request, res: Response) => {
    try {
      const deleted = await db.deleteToken(req.params.id);
      if (!deleted) { res.status(404).json({ error: "Token not found" } as ErrorResponse); return; }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  // ─── 5. Admin Dashboard (served at /) ────────────────────
  app.get("/", adminAuth, otpMiddleware, (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(getAdminHtml(config));
  });

  // Backward compat: /admin → /
  app.get("/admin", adminAuth, (_req: Request, res: Response) => {
    res.redirect(301, "/");
  });

  // ─── 6. Health check ─────────────────────────────────────
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return { app, db, storage };
}

// ─── Admin Dashboard HTML ───────────────────────────────────
function getAdminHtml(config: ServerConfig): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pages MCP Admin</title>
  <style>
    /* ─── Theme Variables ─────────────────────────────────── */
    :root {
      --bg: #f5f5f5; --bg2: #fff; --bg3: #fafafa; --bg4: #f3f4f6;
      --text: #1f2937; --text2: #6b7280; --text3: #9ca3af; --text4: #d1d5db;
      --border: #e5e7eb; --border2: #f3f4f6; --border3: #d1d5db;
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
      --green: #34d399; --green-bg: rgba(52,211,153,0.12);
      --red: #f87171; --red-bg: rgba(248,113,113,0.12);
      --blue: #818cf8; --blue-bg: rgba(129,140,248,0.12);
      --shadow: 0 1px 3px rgba(0,0,0,0.4);
      --header-bg: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); transition: background 0.2s, color 0.2s; -webkit-text-size-adjust: 100%; }

    /* ─── Header ─────────────────────────────────────────── */
    .header { background: var(--header-bg); color: white; padding: 14px 16px; }
    .header-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .header h1 { font-size: 18px; font-weight: 700; }
    .header p { opacity: 0.85; margin-top: 2px; font-size: 12px; }
    .header-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .header-left { min-width: 0; }
    .header-left h1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* ─── Container ──────────────────────────────────────── */
    .container { max-width: 1200px; margin: 0 auto; padding: 16px; }

    /* ─── Stats ──────────────────────────────────────────── */
    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 16px; }
    .stat-card { background: var(--bg2); border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow); }
    .stat-card .label { font-size: 11px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-card .value { font-size: 22px; font-weight: 700; margin-top: 2px; }

    /* ─── Cards ──────────────────────────────────────────── */
    .card { background: var(--bg2); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; margin-bottom: 16px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--border); gap: 8px; }
    .card-header h2 { font-size: 16px; font-weight: 600; }

    /* ─── Tables ─────────────────────────────────────────── */
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; min-width: 500px; }
    th { text-align: left; padding: 10px 14px; background: var(--bg3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text3); border-bottom: 1px solid var(--border); white-space: nowrap; }
    td { padding: 10px 14px; border-bottom: 1px solid var(--border2); font-size: 13px; vertical-align: middle; }
    tr:hover { background: var(--bg3); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ─── Badges ─────────────────────────────────────────── */
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; white-space: nowrap; }
    .badge-blue { background: var(--blue-bg); color: var(--blue); }
    .badge-green { background: var(--green-bg); color: var(--green); }
    .badge-red { background: var(--red-bg); color: var(--red); }

    /* ─── Buttons ────────────────────────────────────────── */
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; border: none; white-space: nowrap; min-height: 36px; }
    .btn-danger { background: var(--red-bg); color: var(--red); }
    .btn-danger:hover { filter: brightness(0.92); }
    .btn-edit { background: var(--blue-bg); color: var(--blue); margin-right: 6px; }
    .btn-edit:hover { filter: brightness(0.92); }
    .btn-primary { background: var(--accent); color: white; padding: 8px 18px; }
    .btn-primary:hover { background: var(--accent2); }
    .btn-cancel { background: var(--bg4); color: var(--text2); padding: 8px 18px; }
    .btn-cancel:hover { filter: brightness(0.92); }
    .btn-success { background: var(--green-bg); color: var(--green); }
    .btn-success:hover { filter: brightness(0.92); }
    .btn-sm { padding: 6px 12px; font-size: 12px; min-height: 32px; }

    /* ─── Empty ──────────────────────────────────────────── */
    .empty { text-align: center; padding: 32px 16px; color: var(--text4); font-size: 14px; }

    /* ─── Modals ─────────────────────────────────────────── */
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 100; justify-content: center; align-items: center; padding: 16px; }
    .modal-overlay.active { display: flex; }
    .modal { background: var(--bg2); border-radius: 16px; padding: 24px; width: 520px; max-width: 100%; max-height: 85vh; overflow-y: auto; }
    .modal h2 { margin-bottom: 16px; font-size: 20px; }
    .modal h3 { margin: 14px 0 6px; font-size: 14px; }
    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 4px; }
    .form-group input, .form-group textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--border3); border-radius: 8px; font-size: 14px; background: var(--bg2); color: var(--text); }
    .form-group textarea { resize: vertical; min-height: 70px; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }

    /* ─── Toast ──────────────────────────────────────────── */
    .toast { position: fixed; bottom: 16px; left: 16px; right: 16px; padding: 12px 16px; border-radius: 10px; color: white; font-size: 14px; z-index: 200; transition: opacity 0.3s; text-align: center; }
    .toast-success { background: #10b981; }
    .toast-error { background: #ef4444; }

    /* ─── Token cell ─────────────────────────────────────── */
    .token-cell { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .token-cell code { background: var(--bg4); padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; user-select: all; word-break: break-all; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .token-cell code:hover { filter: brightness(0.92); }

    /* ─── OTP ────────────────────────────────────────────── */
    .otp-qr { text-align: center; padding: 12px; background: var(--bg4); border-radius: 8px; margin: 10px 0; }
    .otp-qr canvas, .otp-qr img { max-width: 180px !important; width: 100%; height: auto; }
    .otp-secret { font-family: monospace; font-size: 12px; background: var(--bg4); padding: 8px 10px; border-radius: 6px; word-break: break-all; margin: 8px 0; }
    .step { margin: 10px 0; padding: 10px; background: var(--bg4); border-radius: 8px; font-size: 13px; }
    .step-num { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: var(--accent); color: white; border-radius: 50%; font-size: 12px; margin-right: 6px; flex-shrink: 0; }

    /* ─── Theme Switcher ─────────────────────────────────── */
    .theme-btn { background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25); color: white; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .theme-btn:hover { background: rgba(255,255,255,0.25); }
    .theme-btn.active { background: rgba(255,255,255,0.35); border-color: rgba(255,255,255,0.5); }

    /* ─── Row actions ────────────────────────────────────── */
    .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .token-actions { text-align: right; }

    /* ─── Hide on mobile ─────────────────────────────────── */
    .hide-sm { display: none; }

    /* ─── Footer ─────────────────────────────────────────── */
    .footer { margin-top: 32px; padding: 24px 16px; border-top: 1px solid var(--border); text-align: center; }
    .footer-inner { max-width: 1200px; margin: 0 auto; }
    .footer-links { display: flex; justify-content: center; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
    .footer-links a { color: var(--accent); text-decoration: none; font-size: 13px; display: inline-flex; align-items: center; gap: 4px; }
    .footer-links a:hover { text-decoration: underline; }
    .footer-links .sep { color: var(--text4); font-size: 12px; }
    .footer-desc { font-size: 12px; color: var(--text3); margin-bottom: 10px; line-height: 1.5; }
    .footer-coffee { display: inline-flex; align-items: center; gap: 6px; background: var(--bg4); padding: 8px 16px; border-radius: 20px; font-size: 13px; color: var(--text); text-decoration: none; transition: filter 0.2s; }
    .footer-coffee:hover { filter: brightness(0.92); text-decoration: none; }

    /* ─── Desktop ≥768px ─────────────────────────────────── */
    @media (min-width: 768px) {
      .header { padding: 20px 28px; }
      .header h1 { font-size: 24px; }
      .header p { font-size: 14px; }
      .container { padding: 24px; }
      .stats { grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
      .stat-card { padding: 20px; }
      .stat-card .label { font-size: 13px; }
      .stat-card .value { font-size: 28px; }
      .card { margin-bottom: 24px; }
      .card-header { padding: 16px 20px; }
      .card-header h2 { font-size: 18px; }
      th { padding: 12px 20px; font-size: 12px; }
      td { padding: 12px 20px; font-size: 14px; }
      .token-cell code { font-size: 12px; max-width: none; }
      .otp-qr canvas, .otp-qr img { max-width: 200px !important; }
      .otp-secret { font-size: 14px; padding: 8px 12px; }
      .modal { padding: 32px; }
      .toast { left: auto; right: 24px; bottom: 24px; max-width: 400px; }
      .hide-sm { display: table-cell; }
      .token-actions { text-align: left; }
      .footer { padding: 28px 24px; margin-top: 40px; }
      .footer-links { gap: 20px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-row">
      <div class="header-left">
        <h1>🚀 Pages MCP Admin</h1>
        <p>Manage deployed pages &amp; API tokens</p>
      </div>
      <div class="header-right">
        <span id="otpBadge"></span>
        <button class="btn btn-primary btn-sm" onclick="openOtpModal()">🔐 2FA</button>
        <button class="theme-btn" id="themeAuto" onclick="setTheme('auto')" title="Auto">🌓</button>
        <button class="theme-btn" id="themeLight" onclick="setTheme('light')" title="Light">☀️</button>
        <button class="theme-btn" id="themeDark" onclick="setTheme('dark')" title="Dark">🌙</button>
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
        <thead><tr><th>Name</th><th>Token</th><th>Created</th><th class="hide-sm">Last Used</th><th class="token-actions">Actions</th></tr></thead>
        <tbody id="tokenTable"></tbody>
      </table>
      <div class="empty" id="emptyTokens" style="display:none;">No API tokens yet. Create one to use the MCP / Deploy API.</div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-inner">
      <div class="footer-links">
        <a href="https://github.com/ptbsare/pages-mcp-server/issues/new?template=bug_report.yml" target="_blank" rel="noopener">🐛 Report Bug</a>
        <span class="sep">·</span>
        <a href="https://github.com/ptbsare/pages-mcp-server/issues/new?template=feature_request.yml" target="_blank" rel="noopener">✨ Request Feature</a>
        <span class="sep">·</span>
        <a href="https://github.com/ptbsare/pages-mcp-server" target="_blank" rel="noopener">⭐ GitHub</a>
        <span class="sep">·</span>
        <a href="https://github.com/ptbsare" target="_blank" rel="noopener">👤 @ptbsare</a>
      </div>
      <p class="footer-desc">Pages MCP Server — Self-hosted MCP server for deploying static websites</p>
      <a href="https://ptbsare.org/about/" target="_blank" rel="noopener" class="footer-coffee">☕ Buy me a coffee</a>
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
        const shortToken = t.token.length > 16 ? t.token.substring(0, 16) + '...' : t.token;
        return \`<tr>
          <td><strong>\${esc(t.name)}</strong></td>
          <td><div class="token-cell"><code onclick="copyText('\${t.token}')" title="Click to copy">\${shortToken}</code></div></td>
          <td>\${new Date(t.createdAt).toLocaleDateString()}</td>
          <td class="hide-sm">\${t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : '-'}</td>
          <td class="row-actions"><button class="btn btn-danger btn-sm" onclick="deleteToken('\${t.id}')">Delete</button></td>
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
      // Store qrDataUrl for showOtpQr
      window._otpQrData = data;
      openOtpModal();
    }

    async function showOtpQr() {
      if (!window._otpQrData) {
        const data = await api('/api/admin/otp/setup', { method: 'POST', body: '{}' });
        if (!data) return;
        window._otpQrData = data;
      }
      const data = window._otpQrData;
      // Use base64 QR code from backend
      if (data.qrDataUrl) {
        document.getElementById('otpQrImg').src = data.qrDataUrl;
      }
      // Show secret for manual entry
      const content = document.getElementById('otpContent');
      content.innerHTML += \`<p style="margin-top:8px;font-size:12px;color:var(--text3);">Can't scan? Enter manually: <code>\${data.secret}</code></p>\`;
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

// Need NextFunction import
import type { NextFunction } from "express";
