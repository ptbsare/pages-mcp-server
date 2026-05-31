import path from "path";
import os from "os";
import { createApp } from "./app.js";
import { createMcpHandler } from "./mcp-endpoint.js";
import rateLimit from "express-rate-limit";
import { bearerAuth } from "./auth.js";
import { nanoid } from "nanoid";
import type { ServerConfig } from "../shared/types.js";
import { buildUrl } from "../shared/types.js";

function loadConfig(): ServerConfig {
  const port = parseInt(process.env.PORT || "3000", 10);
  // OUT_PORT: external port for public URLs (Docker port mapping).
  // If not set, defaults to internal port.
  // Examples: PORT=3000 OUT_PORT=38300, or PORT=3000 OUT_PORT=80
  const outPort = parseInt(process.env.OUT_PORT || String(port), 10);
  const domain = process.env.DOMAIN || `http://localhost:${outPort}`;
  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const authToken = process.env.AUTH_TOKEN || "";
  const dbPath = process.env.DB_PATH || path.join(os.homedir(), ".pages-mcp", "pages.db");
  const storagePath = process.env.STORAGE_PATH || path.join(os.homedir(), ".pages-mcp", "storage");

  return { port, outPort, domain, adminUsername, adminPassword, authToken, dbPath, storagePath };
}

export function startServer(config?: Partial<ServerConfig>) {
  const defaults = loadConfig();
  const fullConfig: ServerConfig = { ...defaults, ...config };

  const publicUrl = buildUrl(fullConfig.domain, fullConfig.outPort);
  console.log(`\n🚀 Pages MCP Server`);
  console.log(`   URL:     ${publicUrl}`);
  console.log(`   Port:    ${fullConfig.port}`);
  console.log(``);

  const { app, db, storage } = createApp(fullConfig);
  const mcpAuth = bearerAuth(db);
  const mcpHandler = createMcpHandler(fullConfig, db, storage);

  // MCP rate limit: 60 requests per 15 minutes per IP
  const mcpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many MCP requests, please try again later" },
  });

  // Mount MCP endpoint
  app.post("/mcp", mcpLimiter, mcpAuth, mcpHandler);

  const server = app.listen(fullConfig.port, () => {
    console.log(`✅ Server running at http://localhost:${fullConfig.port}`);
  });

  // Seed initial tokens from environment variable
  if (fullConfig.authToken) {
    const tokens = fullConfig.authToken.split(",").map(t => t.trim()).filter(Boolean);
    (async () => {
      for (const tokenValue of tokens) {
        const exists = await db.tokenExists(tokenValue);
        if (!exists) {
          await db.createToken({
            id: nanoid(),
            token: tokenValue,
            name: `Env Token (${tokenValue.substring(0, 8)}...)`,
            createdAt: new Date().toISOString(),
          });
          console.log(`🔑 Seeded token from env: ${tokenValue.substring(0, 8)}...`);
        }
      }
    })();
  }

  // Cleanup is triggered on each deploy operation (deploy_html, deploy_folder, deploy_file)
  // No timer needed — see triggerCleanup() in mcp-endpoint.ts
  const expireDays = parseInt(process.env.SHARE_EXPIRE_DAYS || "0", 10);
  if (expireDays > 0) {
    console.log(`🕐 Auto-cleanup enabled: shares/pages expire after ${expireDays} days (triggered on deploy)`);
  }

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
