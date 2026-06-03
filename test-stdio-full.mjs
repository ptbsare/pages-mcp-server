#!/usr/bin/env node
/**
 * Full integration test for pages-mcp-server via stdio MCP protocol.
 * Tests: deploy_html, deploy_folder, deploy_file, list_pages, delete_page
 */

import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const PROJECT_DIR = "/root/pages-mcp-server";

// Test configuration
const TEST_PORT = 34599;
const TEST_TOKEN = "test-token-123";
const DB_PATH = "/tmp/pages-mcp-test-full.db";
const STORAGE_PATH = "/tmp/pages-mcp-test-full/storage";

function cleanup() {
  try { fs.unlinkSync(DB_PATH); } catch {}
  try { fs.rmSync(STORAGE_PATH, { recursive: true }); } catch {}
}
cleanup();

async function main() {
  console.log("🚀 Starting test server...");
  const server = spawn("node", [
    path.join(PROJECT_DIR, "dist/server/index.js")
  ], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      AUTH_TOKEN: TEST_TOKEN,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "admin123",
      DB_PATH,
      STORAGE_PATH,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  server.stdout.on("data", (d) => {});
  server.stderr.on("data", (d) => {});

  await new Promise((resolve) => {
    server.stdout.on("data", (d) => {
      if (d.toString().includes("Server running")) resolve();
    });
  });
  await new Promise(r => setTimeout(r, 1000));

  const BASE_URL = `http://localhost:${TEST_PORT}`;
  console.log(`   Server ready at ${BASE_URL}`);

  // stdio MCP client
  class McpClient {
    constructor(url, token) {
      this.url = url;
      this.token = token;
      this.proc = null;
      this.mid = 0;
      this.pending = new Map();
    }
    async start() {
      this.proc = spawn("node", [
        path.join(PROJECT_DIR, "dist/cli.js"),
        "client", "--url", this.url, "--auth-token", this.token,
      ], { stdio: ["pipe", "pipe", "pipe"] });
      this.proc.stdout.on("data", (data) => {
        for (const line of data.toString().split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id && this.pending.has(msg.id)) this.pending.get(msg.id)(msg);
          } catch {}
        }
      });
      await new Promise(r => setTimeout(r, 500));
    }
    async call(method, params = {}) {
      const id = ++this.mid;
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((resolve, reject) => {
        this.pending.set(id, (r) => { this.pending.delete(id); r.error ? reject(new Error(r.error.message)) : resolve(r.result); });
        setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("Timeout")); } }, 10000);
      });
    }
    async listTools() { return this.call("tools/list"); }
    async callTool(name, args) { return this.call("tools/call", { name, arguments: args }); }
    stop() { if (this.proc) { this.proc.stdin.end(); this.proc.kill(); } }
  }

  const client = new McpClient(BASE_URL, TEST_TOKEN);
  await client.start();

  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); failed++; }
  }

  console.log("\n📋 Testing MCP tools via stdio...\n");

  // 1. tools/list
  await test("tools/list returns all 5 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(["delete_page","deploy_file","deploy_folder","deploy_html","list_pages"]))
      throw new Error(`Got: ${JSON.stringify(names)}`);
  });

  // 2. deploy_html
  let htmlId = "", htmlShareId = "";
  await test("deploy_html creates a page", async () => {
    const r = await client.callTool("deploy_html", {
      value: "<html><body><h1>Hello World</h1></body></html>",
      name: "Test HTML", description: "A test page"
    });
    const t = r.content[0].text;
    if (!t.includes("deployed successfully")) throw new Error(t);
    const m = t.match(/Share ID: (\S+)/);
    if (!m) throw new Error("No share ID");
    htmlShareId = m[1];
  });

  // 3. list_pages shows it
  await test("list_pages shows deployed page with description", async () => {
    const r = await client.callTool("list_pages", {});
    const t = r.content[0].text;
    if (!t.includes("Test HTML")) throw new Error("Missing page");
    if (!t.includes("A test page")) throw new Error("Missing description");
  });

  // 4. deploy_file via REST (binary)
  let fileShareId = "";
  let fileId = "";
  await test("deploy_file uploads a single file", async () => {
    const content = Buffer.from("Hello file!");
    const resp = await fetch(`${BASE_URL}/api/deploy/file?filename=test.txt&name=Test+File&description=A+file`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: content,
    });
    const data = await resp.json();
    if (!data.success) throw new Error(JSON.stringify(data));
    fileShareId = data.shareId;
    fileId = data.id;
  });

  // 5. deploy_folder via MCP tool (pass local path, client zips it)
  let folderShareId = "";
  await test("deploy_folder deploys a folder via MCP", async () => {
    const tmpDir = "/tmp/test-folder-deploy";
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html><body><h1>Folder</h1></body></html>");
    fs.writeFileSync(path.join(tmpDir, "img.png"), "fake");

    // The stdio client's deploy_folder expects a local path
    // It zips the folder and uploads via REST API
    const r = await client.callTool("deploy_folder", {
      path: tmpDir, name: "Test Folder", description: "A folder"
    });
    const t = r.content[0].text;
    if (!t.includes("Folder deployed")) throw new Error(t);
    const m = t.match(/Share ID: (\S+)/);
    if (!m) throw new Error("No share ID");
    folderShareId = m[1];
  });

  // 6. list_pages shows all 3
  await test("list_pages shows all 3 pages", async () => {
    const r = await client.callTool("list_pages", {});
    const t = r.content[0].text;
    if (!t.includes("Test HTML") || !t.includes("Test File") || !t.includes("Test Folder"))
      throw new Error("Missing pages");
    if (!t.includes("Total: 3")) throw new Error("Not 3 total");
  });

  // 7. delete_page (need DB id, not share id)
  await test("delete_page removes a page", async () => {
    // Get the page ID from list
    const listR = await client.callTool("list_pages", {});
    const listT = listR.content[0].text;
    // Find the DB ID for Test HTML page
    const lines = listT.split("\n");
    let dbId = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("Test HTML") && lines[i+1]?.includes("ID:")) {
        dbId = lines[i+1].match(/ID:\s*(\S+)/)?.[1] || "";
      }
    }
    if (!dbId) throw new Error("Could not find DB ID for Test HTML");

    const r = await client.callTool("delete_page", { id: dbId });
    const t = r.content[0].text;
    if (!t.includes("deleted successfully")) throw new Error(t);
  });

  // 8. list_pages after delete
  await test("list_pages shows 2 pages after deletion", async () => {
    const r = await client.callTool("list_pages", {});
    const t = r.content[0].text;
    if (t.includes("Test HTML")) throw new Error("Deleted page still in list");
    if (!t.includes("Test File") || !t.includes("Test Folder")) throw new Error("Missing pages");
  });

  // 9. Files on disk
  await test("deployed files exist on disk", async () => {
    // Find share IDs from list_pages
    const listR = await client.callTool("list_pages", {});
    const listT = listR.content[0].text;
    const lines = listT.split("\n");
    let fShareId = "", fId = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("Test File") && lines[i+1]?.includes("ID:")) {
        fId = lines[i+1].match(/ID:\s*(\S+)/)?.[1] || "";
      }
      if (lines[i].includes("Test Folder") && lines[i+1]?.includes("ID:")) {
        fShareId = lines[i+1].match(/ID:\s*(\S+)/)?.[1] || "";
      }
    }
    // Get share IDs from the URL line
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("URL:") && lines[i].includes("/f/")) {
        const m = lines[i].match(/\/f\/(\S+)/);
        if (m && !fShareId) fShareId = m[1];
      }
      if (lines[i].includes("URL:") && lines[i].includes("/s/")) {
        const m = lines[i].match(/\/s\/(\S+)/);
        if (m && !fShareId) fShareId = m[1];
      }
    }
    if (fileShareId && !fs.existsSync(path.join(STORAGE_PATH, fileShareId)))
      throw new Error(`File share ${fileShareId} missing`);
    if (folderShareId && !fs.existsSync(path.join(STORAGE_PATH, folderShareId, "index.html")))
      throw new Error(`Folder ${folderShareId} index.html missing`);
  });

  // 10. HTTP access
  await test("deployed pages accessible via HTTP", async () => {
    const resp = await fetch(`${BASE_URL}/s/${folderShareId}/`);
    if (!resp.ok) throw new Error(`Folder returned ${resp.status}`);
    const body = await resp.text();
    if (!body.includes("Folder")) throw new Error("Content mismatch");
  });

  client.stop();
  server.kill();

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  cleanup();
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
