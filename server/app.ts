import express, { Request, Response } from "express";
import mime from "mime-types";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import { PagesDatabase } from "./db.js";
import { FileStorage } from "./storage.js";
import { bearerAuth, basicAuth } from "./auth.js";
import type {
  ServerConfig,
  DeployedPage,
  DeployResponse,
  ListPagesResponse,
  ErrorResponse,
} from "../shared/types.js";

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
  // Public, no auth required
  app.get("/s/:shareId", async (req: Request, res: Response) => {
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

  app.get("/s/:shareId/*", async (req: Request, res: Response) => {
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
  const deployAuth = bearerAuth(config.authToken);

  // POST /api/deploy/html — deploy a single HTML string
  app.post("/api/deploy/html", deployAuth, (req: Request, res: Response) => {
    try {
      const { value, name, description } = req.body;
      if (!value || typeof value !== "string") {
        res.status(400).json({ error: "Missing or invalid 'value' field" } as ErrorResponse);
        return;
      }

      const shareId = nanoid(12);
      const id = nanoid();
      const now = new Date().toISOString();

      storage.storeHtml(shareId, value);

      const page: DeployedPage = {
        id,
        shareId,
        name: name || `Page ${shareId}`,
        description,
        fileCount: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.createPage(page);

      const url = `${config.domain}/s/${shareId}`;
      const response: DeployResponse = {
        id,
        shareId,
        url,
        name: page.name,
        createdAt: now,
      };
      res.status(201).json(response);
    } catch (err: any) {
      res.status(500).json({ error: "Deploy failed", message: err.message } as ErrorResponse);
    }
  });

  // POST /api/deploy/folder — deploy a folder (base64 zip)
  app.post("/api/deploy/folder", deployAuth, (req: Request, res: Response) => {
    try {
      const { zipBase64, name, description } = req.body;
      if (!zipBase64 || typeof zipBase64 !== "string") {
        res.status(400).json({ error: "Missing or invalid 'zipBase64' field" } as ErrorResponse);
        return;
      }

      const shareId = nanoid(12);
      const id = nanoid();
      const now = new Date().toISOString();

      const result = storage.storeZip(shareId, zipBase64);

      const page: DeployedPage = {
        id,
        shareId,
        name: name || `Page ${shareId}`,
        description,
        fileCount: result.fileCount,
        createdAt: now,
        updatedAt: now,
      };
      db.createPage(page);

      const url = `${config.domain}/s/${shareId}`;
      const response: DeployResponse = {
        id,
        shareId,
        url,
        name: page.name,
        createdAt: now,
      };
      res.status(201).json(response);
    } catch (err: any) {
      res.status(500).json({ error: "Deploy failed", message: err.message } as ErrorResponse);
    }
  });

  // ─── 3. Admin API (Basic auth) ───────────────────────────
  const adminAuth = basicAuth(config.adminUsername, config.adminPassword);

  // List all pages
  app.get("/api/admin/pages", adminAuth, async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const result = await db.listPages(limit, offset);
      const response: ListPagesResponse = {
        pages: result.pages,
        total: result.total,
      };
      res.json(response);
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  // Get single page
  app.get("/api/admin/pages/:id", adminAuth, async (req: Request, res: Response) => {
    try {
      const page = await db.getPageById(req.params.id);
      if (!page) {
        res.status(404).json({ error: "Page not found" } as ErrorResponse);
        return;
      }
      res.json(page);
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  // Update page metadata
  app.put("/api/admin/pages/:id", adminAuth, async (req: Request, res: Response) => {
    try {
      const { name, description } = req.body;
      const updated = await db.updatePage(req.params.id, { name, description });
      if (!updated) {
        res.status(404).json({ error: "Page not found or nothing to update" } as ErrorResponse);
        return;
      }
      const page = await db.getPageById(req.params.id);
      res.json(page);
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  // Delete page
  app.delete("/api/admin/pages/:id", adminAuth, async (req: Request, res: Response) => {
    try {
      const page = await db.getPageById(req.params.id);
      if (!page) {
        res.status(404).json({ error: "Page not found" } as ErrorResponse);
        return;
      }
      storage.deletePage(page.shareId);
      await db.deletePage(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message } as ErrorResponse);
    }
  });

  // ─── 4. Admin Dashboard (static HTML) ────────────────────
  app.get("/admin", adminAuth, (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(getAdminHtml(config));
  });

  // ─── 5. Health check ─────────────────────────────────────
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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px 32px; }
    .header h1 { font-size: 24px; font-weight: 600; }
    .header p { opacity: 0.85; margin-top: 4px; font-size: 14px; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-card .label { font-size: 13px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .page-list { background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; }
    .page-list table { width: 100%; border-collapse: collapse; }
    .page-list th { text-align: left; padding: 14px 20px; background: #fafafa; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; border-bottom: 1px solid #eee; }
    .page-list td { padding: 14px 20px; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    .page-list tr:hover { background: #fafafa; }
    .page-list a { color: #667eea; text-decoration: none; }
    .page-list a:hover { text-decoration: underline; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
    .badge-blue { background: #eef2ff; color: #6366f1; }
    .btn { display: inline-block; padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; border: none; }
    .btn-danger { background: #fee2e2; color: #dc2626; }
    .btn-danger:hover { background: #fecaca; }
    .btn-edit { background: #eef2ff; color: #6366f1; margin-right: 6px; }
    .btn-edit:hover { background: #e0e7ff; }
    .empty { text-align: center; padding: 60px 20px; color: #999; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 100; justify-content: center; align-items: center; }
    .modal-overlay.active { display: flex; }
    .modal { background: white; border-radius: 12px; padding: 32px; width: 480px; max-width: 90%; }
    .modal h2 { margin-bottom: 20px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; }
    .form-group input, .form-group textarea { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
    .form-group textarea { resize: vertical; min-height: 80px; }
    .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
    .btn-primary { background: #667eea; color: white; padding: 8px 20px; }
    .btn-primary:hover { background: #5a6fd6; }
    .btn-cancel { background: #f3f4f6; color: #666; padding: 8px 20px; }
    .btn-cancel:hover { background: #e5e7eb; }
    .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px; color: white; font-size: 14px; z-index: 200; transition: opacity 0.3s; }
    .toast-success { background: #10b981; }
    .toast-error { background: #ef4444; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🚀 Pages MCP Admin</h1>
    <p>Manage your deployed static pages</p>
  </div>
  <div class="container">
    <div class="stats">
      <div class="stat-card">
        <div class="label">Total Pages</div>
        <div class="value" id="totalPages">-</div>
      </div>
      <div class="stat-card">
        <div class="label">Domain</div>
        <div class="value" style="font-size:16px;margin-top:8px;word-break:break-all;">${config.domain}</div>
      </div>
    </div>
    <div class="page-list">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Share URL</th>
            <th>Files</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="pageTable"></tbody>
      </table>
      <div class="empty" id="emptyState" style="display:none;">No pages deployed yet.</div>
    </div>
  </div>

  <!-- Edit Modal -->
  <div class="modal-overlay" id="editModal">
    <div class="modal">
      <h2>Edit Page</h2>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="editName" />
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="editDescription"></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveEdit()">Save</button>
      </div>
    </div>
  </div>

  <script>
    let pages = [];
    let editingId = null;

    async function loadPages() {
      try {
        const res = await fetch('/api/admin/pages');
        const data = await res.json();
        pages = data.pages || [];
        document.getElementById('totalPages').textContent = data.total || 0;
        renderTable();
      } catch (e) {
        showToast('Failed to load pages', 'error');
      }
    }

    function renderTable() {
      const tbody = document.getElementById('pageTable');
      const empty = document.getElementById('emptyState');
      if (pages.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      tbody.innerHTML = pages.map(p => {
        const url = '${config.domain}/s/' + p.shareId;
        const created = new Date(p.createdAt).toLocaleDateString();
        return \`<tr>
          <td><strong>\${escapeHtml(p.name)}</strong>\${p.description ? '<br><small style=\\"color:#888\\">'+escapeHtml(p.description)+'</small>' : ''}</td>
          <td><a href="\${url}" target="_blank">/s/\${p.shareId}</a></td>
          <td><span class="badge badge-blue">\${p.fileCount}</span></td>
          <td>\${created}</td>
          <td>
            <button class="btn btn-edit" onclick="openEdit('\${p.id}')">Edit</button>
            <button class="btn btn-danger" onclick="deletePage('\${p.id}')">Delete</button>
          </td>
        </tr>\`;
      }).join('');
    }

    function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function openEdit(id) {
      const p = pages.find(x => x.id === id);
      if (!p) return;
      editingId = id;
      document.getElementById('editName').value = p.name;
      document.getElementById('editDescription').value = p.description || '';
      document.getElementById('editModal').classList.add('active');
    }

    function closeModal() {
      document.getElementById('editModal').classList.remove('active');
      editingId = null;
    }

    async function saveEdit() {
      try {
        await fetch('/api/admin/pages/' + editingId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: document.getElementById('editName').value,
            description: document.getElementById('editDescription').value
          })
        });
        closeModal();
        showToast('Page updated', 'success');
        loadPages();
      } catch (e) { showToast('Update failed', 'error'); }
    }

    async function deletePage(id) {
      if (!confirm('Delete this page? This cannot be undone.')) return;
      try {
        await fetch('/api/admin/pages/' + id, { method: 'DELETE' });
        showToast('Page deleted', 'success');
        loadPages();
      } catch (e) { showToast('Delete failed', 'error'); }
    }

    function showToast(msg, type) {
      const t = document.createElement('div');
      t.className = 'toast toast-' + type;
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2500);
    }

    loadPages();
  </script>
</body>
</html>`;
}
