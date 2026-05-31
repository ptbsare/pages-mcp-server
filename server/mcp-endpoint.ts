import { Request, Response } from "express";
import { PagesDatabase } from "./db.js";
import { FileStorage } from "./storage.js";
import type { ServerConfig } from "../shared/types.js";
import { buildUrl } from "../shared/types.js";
import { nanoid } from "nanoid";

/** Trigger cleanup of expired shares/pages (non-blocking) */
function triggerCleanup(storage: FileStorage, db: PagesDatabase) {
  const expireDays = parseInt(process.env.SHARE_EXPIRE_DAYS || "0", 10);
  if (expireDays <= 0) return;
  // Fire and forget — don't block the response
  setImmediate(() => {
    try {
      const result = storage.cleanupExpired(expireDays, db);
      const total = result.sharesDeleted + result.pagesDeleted;
      if (total > 0) console.log(`🧹 Cleaned up ${total} expired items (${result.sharesDeleted} shares, ${result.pagesDeleted} pages)`);
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  });
}

/**
 * Handle MCP JSON-RPC requests over HTTP at /mcp
 * This implements the Streamable HTTP transport pattern.
 */
export function createMcpHandler(config: ServerConfig, db: PagesDatabase, storage: FileStorage) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body;

      // Handle initialize
      if (body.method === "initialize") {
        res.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: {
              name: "pages-mcp-server",
              version: "1.0.0",
            },
            capabilities: {
              tools: {},
            },
          },
        });
        return;
      }

      // Handle tools/list
      if (body.method === "tools/list") {
        res.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "deploy_html",
                description:
                  "Deploy an HTML string as a publicly accessible static page. Returns a shareable URL.",
                inputSchema: {
                  type: "object",
                  properties: {
                    value: {
                      type: "string",
                      description: "The complete HTML content to deploy.",
                    },
                    name: {
                      type: "string",
                      description: "Optional human-readable name for the page.",
                    },
                    description: {
                      type: "string",
                      description: "Optional description for the page.",
                    },
                  },
                  required: ["value"],
                },
              },
              {
                name: "list_pages",
                description: "List all deployed pages.",
                inputSchema: {
                  type: "object",
                  properties: {
                    limit: {
                      type: "number",
                      description: "Max number of results (default 50).",
                    },
                    offset: {
                      type: "number",
                      description: "Offset for pagination (default 0).",
                    },
                  },
                },
              },
              {
                name: "delete_page",
                description: "Delete a deployed page by its ID.",
                inputSchema: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      description: "The page ID to delete.",
                    },
                  },
                  required: ["id"],
                },
              },

            ],
          },
        });
        return;
      }

      // Handle tools/call
      if (body.method === "tools/call") {
        const { name, arguments: args } = body.params;

        if (name === "deploy_html") {
          const { value, name: pageName, description } = args as any;
          if (!value) {
            res.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: "Error: Missing required argument: value" }],
                isError: true,
              },
            });
            return;
          }

          const shareId = nanoid(12);
          const id = nanoid();
          const now = new Date().toISOString();

          storage.storeHtml(shareId, value);

          await db.createPage({
            id,
            shareId,
            name: pageName || `Page ${shareId}`,
            description,
            fileCount: 1,
            createdAt: now,
            updatedAt: now,
          });

          const url = `${buildUrl(config.domain, config.outPort)}/s/${shareId}`;
          res.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [
                {
                  type: "text",
                  text: `✅ Page deployed successfully!\n\nURL: ${url}\nID: ${id}\nShare ID: ${shareId}`,
                },
              ],
            },
          });
          triggerCleanup(storage, db);
          return;
        }

        if (name === "list_pages") {
          const { limit = 50, offset = 0 } = args as any;
          const result = await db.listPages(limit, offset);

          if (result.pages.length === 0) {
            res.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: "No pages deployed yet." }],
              },
            });
            return;
          }

          const text = result.pages
            .map((p) => {
              const urlPrefix = (p.type === 'folder' || p.type === 'file') ? '/f/' : '/s/';
              const url = `${buildUrl(config.domain, config.outPort)}${urlPrefix}/${p.shareId}`;
              const lockInfo = p.locked ? " [🔒]" : "";
              const typeIcon = p.type === "folder" ? "📁" : p.type === "file" ? "📄" : "🌐";
              const sizeInfo = p.totalSize ? ` (${p.totalSize} bytes)` : "";
              return `${typeIcon} ${p.name}${lockInfo}${sizeInfo}\n   ID: ${p.id}\n   URL: ${url}\n   Type: ${p.type || "page"}\n   Created: ${p.createdAt}`;
            })
            .join("\n\n");

          res.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: `Total: ${result.total} pages\n\n${text}` }],
            },
          });
          return;
        }

        if (name === "delete_page") {
          const { id } = args as any;
          if (!id) {
            res.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: "Error: Missing required argument: id" }],
                isError: true,
              },
            });
            return;
          }

          const page = await db.getPageById(id);
          if (!page) {
            res.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: `Error: Page not found: ${id}` }],
                isError: true,
              },
            });
            return;
          }

          storage.deletePage(page.shareId);
          await db.deletePage(id);

          res.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: `✅ Page "${page.name}" deleted successfully.` }],
            },
          });
          return;
        }

        // Unknown tool
        res.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        });
        return;
      }

      // Handle resources/list, prompts/list
      if (body.method === "resources/list" || body.method === "prompts/list") {
        const key = body.method.split("/")[0];
        res.json({ jsonrpc: "2.0", id: body.id, result: { [key]: [] } });
        return;
      }

      // Unknown method
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Method not found: ${body.method}` },
      });
    } catch (error: any) {
      console.error("MCP Error:", error);
      res.status(500).json({
        jsonrpc: "2.0",
        id: req.body?.id ?? null,
        error: { code: -32000, message: "Internal server error" },
      });
    }
  };
}
