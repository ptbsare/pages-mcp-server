#!/usr/bin/env node

/**
 * Pages MCP CLI
 *
 * Usage:
 *   pages-mcp server                    # Start as server
 *   pages-mcp server --port 8080        # Custom port
 *   pages-mcp client --url <endpoint>   # Start as stdio MCP client
 *   pages-mcp client --interactive      # Interactive HTTP client mode
 */

import { startServer } from "../../server/index.js";
import { startStdioServer } from "./stdio-server.js";
import { PagesMcpHttpClient } from "./http-client.js";
import readline from "readline";

const args = process.argv.slice(2);

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

async function runServer() {
  const port = parseInt(getFlag("--port") || process.env.PORT || "3000", 10);
  const domain = getFlag("--domain") || process.env.DOMAIN || `http://localhost:${port}`;
  const adminUsername = getFlag("--admin-user") || process.env.ADMIN_USERNAME || "admin";
  const adminPassword = getFlag("--admin-pass") || process.env.ADMIN_PASSWORD || "admin123";
  const authToken = getFlag("--auth-token") || process.env.AUTH_TOKEN || "my-secret-token";
  const dbPath = getFlag("--db-path") || process.env.DB_PATH;
  const storagePath = getFlag("--storage-path") || process.env.STORAGE_PATH;

  const config: any = { port, domain, adminUsername, adminPassword, authToken };
  if (dbPath) config.dbPath = dbPath;
  if (storagePath) config.storagePath = storagePath;

  startServer(config);
}

async function runClient() {
  const url = getFlag("--url") || process.env.MCP_SERVER_URL;
  const authToken = getFlag("--auth-token") || process.env.AUTH_TOKEN || "my-secret-token";

  if (!url) {
    console.error("❌ Missing --url flag or MCP_SERVER_URL env var");
    console.error("   Example: pages-mcp client --url https://mysite.com --auth-token my-secret");
    process.exit(1);
  }

  if (hasFlag("--interactive")) {
    await runInteractive(url, authToken);
  } else {
    // Default: start stdio MCP server
    await startStdioServer(url, authToken);
  }
}

async function runInteractive(url: string, authToken: string) {
  const client = new PagesMcpHttpClient(url, authToken);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n📡 Interactive Pages MCP Client`);
  console.log(`   Server: ${url}`);
  console.log(`   Commands: deploy-html, deploy-folder, list, delete, tools, quit\n`);

  const ask = () => {
    rl.question("> ", async (input) => {
      const parts = input.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase();

      try {
        switch (cmd) {
          case "deploy-html": {
            const html = parts.slice(1).join(" ");
            if (!html) {
              console.log("Usage: deploy-html <html content>");
              break;
            }
            const result = await client.deployHtml(html);
            console.log(result);
            break;
          }
          case "deploy-folder": {
            const folderPath = parts[1];
            if (!folderPath) {
              console.log("Usage: deploy-folder <path>");
              break;
            }
            const result = await client.deployFolder(folderPath);
            console.log(result);
            break;
          }
          case "list": {
            const result = await client.listPages();
            console.log(result);
            break;
          }
          case "delete": {
            const id = parts[1];
            if (!id) {
              console.log("Usage: delete <id>");
              break;
            }
            const result = await client.deletePage(id);
            console.log(result);
            break;
          }
          case "tools": {
            const tools = await client.listTools();
            tools.forEach((t: any) => console.log(`  • ${t.name}: ${t.description}`));
            break;
          }
          case "quit":
          case "exit":
            rl.close();
            return;
          default:
            console.log("Unknown command. Available: deploy-html, deploy-folder, list, delete, tools, quit");
        }
      } catch (e: any) {
        console.error("Error:", e.message);
      }

      ask();
    });
  };

  ask();
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  const mode = args[0];

  switch (mode) {
    case "server":
      await runServer();
      break;
    case "client":
      await runClient();
      break;
    default:
      console.log(`
Pages MCP Server v1.0.0

Usage:
  pages-mcp server [options]     Start as server
  pages-mcp client [options]     Start as client

Server Options:
  --port <number>          Port to listen on (default: 3000)
  --domain <url>           Base domain (default: http://localhost:<port>)
  --admin-user <name>      Admin username (default: admin)
  --admin-pass <pass>      Admin password (default: admin123)
  --auth-token <token>     Bearer token for API auth (default: my-secret-token)
  --db-path <path>         SQLite database path
  --storage-path <path>    File storage path

Client Options:
  --url <endpoint>         Remote server URL (or MCP_SERVER_URL env)
  --auth-token <token>     Auth token (or AUTH_TOKEN env)
  --interactive            Interactive CLI mode (default: stdio MCP server)

Environment Variables:
  PORT, DOMAIN, ADMIN_USERNAME, ADMIN_PASSWORD, AUTH_TOKEN, DB_PATH, STORAGE_PATH, MCP_SERVER_URL

Examples:
  pages-mcp server --port 8080 --domain https://mysite.com
  pages-mcp client --url https://mysite.com --interactive
  pages-mcp client --url https://mysite.com  # stdio mode for AI assistants
`);
  }
}

export { main };
