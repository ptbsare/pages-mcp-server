import initSqlJs, { type Database } from "sql.js";
import fs from "fs";
import path from "path";
import type { DeployedPage, AuthToken } from "../shared/types.js";

export class PagesDatabase {
  private db: Database | null = null;
  private dbPath: string;
  private initialized = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private async ensureDb(): Promise<Database> {
    if (this.db) return this.db;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.init();
    this.save();
    return this.db;
  }

  private init(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        share_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        description TEXT DEFAULT '',
        type TEXT NOT NULL DEFAULT 'page',
        file_count INTEGER NOT NULL DEFAULT 0,
        total_size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        locked INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id TEXT PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_used_at TEXT
      )
    `);
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      )
    `);
  }

  private save(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  async createPage(page: DeployedPage & { type?: string; totalSize?: number; locked?: boolean }): Promise<void> {
    const db = await this.ensureDb();
    const stmt = db.prepare(
      `INSERT INTO pages (id, share_id, name, description, type, file_count, total_size, created_at, updated_at, locked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run([page.id, page.shareId, page.name, page.description ?? "", page.type || "page", page.fileCount, page.totalSize || 0, page.createdAt, page.updatedAt, page.locked ? 1 : 0]);
    stmt.free();
    this.save();
  }

  async getPageByShareId(shareId: string): Promise<DeployedPage | undefined> {
    const db = await this.ensureDb();
    const stmt = db.prepare(`SELECT * FROM pages WHERE share_id = ?`);
    stmt.bind([shareId]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      stmt.free();
      return this.rowToPage(row);
    }
    stmt.free();
    return undefined;
  }

  async getPageById(id: string): Promise<DeployedPage | undefined> {
    const db = await this.ensureDb();
    const stmt = db.prepare(`SELECT * FROM pages WHERE id = ?`);
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      stmt.free();
      return this.rowToPage(row);
    }
    stmt.free();
    return undefined;
  }

  async listPages(limit = 50, offset = 0): Promise<{ pages: DeployedPage[]; total: number }> {
    const db = await this.ensureDb();

    const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM pages`);
    countStmt.step();
    const total = (countStmt.getAsObject() as any).cnt as number;
    countStmt.free();

    const pagesStmt = db.prepare(`SELECT * FROM pages ORDER BY created_at DESC LIMIT ? OFFSET ?`);
    pagesStmt.bind([limit, offset]);
    const pages: DeployedPage[] = [];
    while (pagesStmt.step()) {
      pages.push(this.rowToPage(pagesStmt.getAsObject() as any));
    }
    pagesStmt.free();

    return { pages, total };
  }

  async updatePage(id: string, updates: { name?: string; description?: string; locked?: boolean }): Promise<boolean> {
    const db = await this.ensureDb();
    const sets: string[] = [];
    const vals: any[] = [];

    if (updates.name !== undefined) {
      sets.push("name = ?");
      vals.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push("description = ?");
      vals.push(updates.description);
    }
    if (updates.locked !== undefined) {
      sets.push("locked = ?");
      vals.push(updates.locked ? 1 : 0);
    }

    if (sets.length === 0) return false;

    sets.push("updated_at = ?");
    vals.push(new Date().toISOString());
    vals.push(id);

    const sql = `UPDATE pages SET ${sets.join(", ")} WHERE id = ?`;
    db.run(sql, vals);
    this.save();

    // Check if row existed
    const check = db.prepare(`SELECT COUNT(*) as cnt FROM pages WHERE id = ?`);
    check.bind([id]);
    check.step();
    const count = (check.getAsObject() as any).cnt as number;
    check.free();
    return count > 0;
  }

  async deletePage(id: string): Promise<boolean> {
    const db = await this.ensureDb();
    db.run(`DELETE FROM pages WHERE id = ?`, [id]);
    const changes = db.getRowsModified();
    this.save();
    return changes > 0;
  }

  private rowToPage(row: any): DeployedPage & { type: string; totalSize: number; locked: boolean } {
    return {
      id: row.id,
      shareId: row.share_id,
      name: row.name,
      description: row.description,
      type: row.type || "page",
      fileCount: row.file_count,
      totalSize: row.total_size || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      locked: row.locked === 1,
    };
  }

  // ─── Auth Token CRUD ─────────────────────────────────

  async createToken(token: AuthToken): Promise<void> {
    const db = await this.ensureDb();
    db.run(
      `INSERT INTO auth_tokens (id, token, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)`,
      [token.id, token.token, token.name, token.createdAt, token.lastUsedAt ?? null]
    );
    this.save();
  }

  async getTokenByValue(tokenValue: string): Promise<AuthToken | undefined> {
    const db = await this.ensureDb();
    const stmt = db.prepare(`SELECT * FROM auth_tokens WHERE token = ?`);
    stmt.bind([tokenValue]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      stmt.free();
      return this.rowToAuthToken(row);
    }
    stmt.free();
    return undefined;
  }

  async listTokens(): Promise<AuthToken[]> {
    const db = await this.ensureDb();
    const stmt = db.prepare(`SELECT * FROM auth_tokens ORDER BY created_at DESC`);
    const tokens: AuthToken[] = [];
    while (stmt.step()) {
      tokens.push(this.rowToAuthToken(stmt.getAsObject() as any));
    }
    stmt.free();
    return tokens;
  }

  async deleteToken(id: string): Promise<boolean> {
    const db = await this.ensureDb();
    db.run(`DELETE FROM auth_tokens WHERE id = ?`, [id]);
    const changes = db.getRowsModified();
    this.save();
    return changes > 0;
  }

  async updateTokenLastUsed(tokenValue: string): Promise<void> {
    const db = await this.ensureDb();
    db.run(`UPDATE auth_tokens SET last_used_at = ? WHERE token = ?`, [new Date().toISOString(), tokenValue]);
    this.save();
  }

  async tokenExists(tokenValue: string): Promise<boolean> {
    const db = await this.ensureDb();
    const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM auth_tokens WHERE token = ?`);
    stmt.bind([tokenValue]);
    stmt.step();
    const count = (stmt.getAsObject() as any).cnt as number;
    stmt.free();
    return count > 0;
  }

  private rowToAuthToken(row: any): AuthToken {
    return {
      id: row.id,
      token: row.token,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at || undefined,
    };
  }

  // ─── OTP ──────────────────────────────────────────────

  async getOtpSecret(): Promise<string | undefined> {
    const db = await this.ensureDb();
    const stmt = db.prepare(`SELECT value FROM settings WHERE key = 'otp_secret'`);
    stmt.bind([]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      stmt.free();
      return row.value || undefined;
    }
    stmt.free();
    return undefined;
  }

  async setOtpSecret(secret: string): Promise<void> {
    const db = await this.ensureDb();
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('otp_secret', ?)`, [secret]);
    this.save();
  }

  async getOtpEnabled(): Promise<boolean> {
    const db = await this.ensureDb();
    const stmt = db.prepare(`SELECT value FROM settings WHERE key = 'otp_enabled'`);
    stmt.bind([]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      stmt.free();
      return row.value === '1';
    }
    stmt.free();
    return false;
  }

  async setOtpEnabled(enabled: boolean): Promise<void> {
    const db = await this.ensureDb();
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('otp_enabled', ?)`, [enabled ? '1' : '0']);
    this.save();
  }

  close(): void {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
  }
}
