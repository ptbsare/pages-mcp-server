import path from "path";
import os from "os";
import { createApp } from "./app.js";
import { createMcpHandler } from "./mcp-endpoint.js";
import { bearerAuth } from "./auth.js";
import type { ServerConfig } from "../shared/types.js";

function loadConfig(): ServerConfig {
  const port = parseInt(process.env.PORT || "3000", 10);
  const domain = process.env.DOMAIN || `http://localhost:${port}`;
  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const authToken = process.env.AUTH_TOKEN || "my-secret-token";
  const dbPath = process.env.DB_PATH || path.join(os.homedir(), ".pages-mcp", "pages.db");
  const storagePath = process.env.STORAGE_PATH || path.join(os.homedir(), ".pages-mcp", "storage");

  return { port, domain, adminUsername, adminPassword, authToken, dbPath, storagePath };
}

export function startServer(config?: Partial<ServerConfig>) {
  const defaults = loadConfig();
  const fullConfig: ServerConfig = { ...defaults, ...config };

  console.log(`\n🚀 Pages MCP Server`);
  console.log(`   Domain:  ${fullConfig.domain}`);
  console.log(`   Port:    ${fullConfig.port}`);
  console.log(`   Admin:   ${fullConfig.domain}/admin`);
  console.log(`   MCP:     ${fullConfig.domain}/mcp`);
  console.log(`   Deploy:  POST ${fullConfig.domain}/api/deploy/html`);
  console.log(``);

  const { app, db, storage } = createApp(fullConfig);
  const mcpAuth = bearerAuth(fullConfig.authToken);
  const mcpHandler = createMcpHandler(fullConfig, db, storage);

  // Mount MCP endpoint
  app.post("/mcp", mcpAuth, mcpHandler);

  const server = app.listen(fullConfig.port, () => {
    console.log(`✅ Server running at http://localhost:${fullConfig.port}`);
  });

  return { server, app, db, storage };
}

// Auto-run if executed directly
const isMain =
  process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("server/index.js");

if (isMain && !process.argv[1]?.includes("dist/client")) {
  startServer();
}
