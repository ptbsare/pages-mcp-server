import initSqlJs, { type Database } from "sql.js";
import fs from "fs";
import path from "path";
import type { DeployedPage } from "../shared/types.js";

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
        file_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  private save(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  async createPage(page: DeployedPage): Promise<void> {
    const db = await this.ensureDb();
    const stmt = db.prepare(
      `INSERT INTO pages (id, share_id, name, description, file_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run([page.id, page.shareId, page.name, page.description ?? "", page.fileCount, page.createdAt, page.updatedAt]);
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

  async updatePage(id: string, updates: { name?: string; description?: string }): Promise<boolean> {
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

  private rowToPage(row: any): DeployedPage {
    return {
      id: row.id,
      shareId: row.share_id,
      name: row.name,
      description: row.description,
      fileCount: row.file_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  close(): void {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
  }
}
