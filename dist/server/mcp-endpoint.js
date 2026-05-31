import { FileStorage } from "./storage.js";
import { buildUrl } from "../shared/types.js";
import { nanoid } from "nanoid";
/**
 * Handle MCP JSON-RPC requests over HTTP at /mcp
 * This implements the Streamable HTTP transport pattern.
 */
export function createMcpHandler(config, db, storage) {
    return async (req, res) => {
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
                                description: "Deploy an HTML string as a publicly accessible static page. Returns a shareable URL.",
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
                                name: "deploy_folder",
                                description: "Deploy a local folder containing a static website (must include index.html). Returns a shareable URL.",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        path: {
                                            type: "string",
                                            description: "Absolute path to the local folder to deploy.",
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
                                    required: ["path"],
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
                    const { value, name: pageName, description } = args;
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
                    const url = `${buildUrl(config.domain, config.port)}/s/${shareId}`;
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
                    return;
                }
                if (name === "deploy_folder") {
                    const { path: folderPath, name: pageName, description } = args;
                    if (!folderPath) {
                        res.json({
                            jsonrpc: "2.0",
                            id: body.id,
                            result: {
                                content: [{ type: "text", text: "Error: Missing required argument: path" }],
                                isError: true,
                            },
                        });
                        return;
                    }
                    // SSRF prevention: block sensitive system directories
                    const pathCheck = FileStorage.validateFolderPath(folderPath);
                    if (!pathCheck.valid) {
                        res.json({
                            jsonrpc: "2.0",
                            id: body.id,
                            result: {
                                content: [{ type: "text", text: `Error: ${pathCheck.error}` }],
                                isError: true,
                            },
                        });
                        return;
                    }
                    const fs = await import("fs");
                    if (!fs.existsSync(folderPath)) {
                        res.json({
                            jsonrpc: "2.0",
                            id: body.id,
                            result: {
                                content: [{ type: "text", text: `Error: Folder not found: ${folderPath}` }],
                                isError: true,
                            },
                        });
                        return;
                    }
                    const shareId = nanoid(12);
                    const id = nanoid();
                    const now = new Date().toISOString();
                    const result = storage.storeFolder(shareId, folderPath);
                    if (!result.hasIndex) {
                        storage.deletePage(shareId);
                        res.json({
                            jsonrpc: "2.0",
                            id: body.id,
                            result: {
                                content: [
                                    {
                                        type: "text",
                                        text: "Error: Folder must contain an index.html file at the root.",
                                    },
                                ],
                                isError: true,
                            },
                        });
                        return;
                    }
                    await db.createPage({
                        id,
                        shareId,
                        name: pageName || `Page ${shareId}`,
                        description,
                        fileCount: result.fileCount,
                        createdAt: now,
                        updatedAt: now,
                    });
                    const url = `${buildUrl(config.domain, config.port)}/s/${shareId}`;
                    res.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: `✅ Folder deployed successfully!\n\nURL: ${url}\nID: ${id}\nShare ID: ${shareId}\nFiles: ${result.fileCount}`,
                                },
                            ],
                        },
                    });
                    return;
                }
                if (name === "list_pages") {
                    const { limit = 50, offset = 0 } = args;
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
                        const url = `${buildUrl(config.domain, config.port)}/s/${p.shareId}`;
                        return `📄 ${p.name}\n   ID: ${p.id}\n   URL: ${url}\n   Files: ${p.fileCount}\n   Created: ${p.createdAt}`;
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
                    const { id } = args;
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
        }
        catch (error) {
            console.error("MCP Error:", error);
            res.status(500).json({
                jsonrpc: "2.0",
                id: req.body?.id ?? null,
                error: { code: -32000, message: "Internal server error: " + error.message },
            });
        }
    };
}
//# sourceMappingURL=mcp-endpoint.js.map