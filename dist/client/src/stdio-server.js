/**
 * Stdio MCP Server — runs locally, communicates over stdin/stdout.
 * Connects to a remote Pages MCP server via HTTP.
 * Provides tools: deploy_html, deploy_folder, list_pages, delete_page
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PagesMcpHttpClient } from "./http-client.js";
export async function startStdioServer(remoteUrl, authToken) {
    const client = new PagesMcpHttpClient(remoteUrl, authToken);
    const server = new Server({
        name: "pages-mcp-client",
        version: "1.0.0",
    }, {
        capabilities: {
            tools: {},
        },
    });
    // List tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "deploy_html",
                    description: "Deploy an HTML string as a publicly accessible static page on the remote server. Returns a shareable URL.",
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
                    description: "Deploy a local folder containing a static website (must include index.html) to the remote server. Returns a shareable URL.",
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
                    description: "List all deployed pages on the remote server.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            limit: { type: "number", description: "Max results (default 50)." },
                            offset: { type: "number", description: "Offset (default 0)." },
                        },
                    },
                },
                {
                    name: "delete_page",
                    description: "Delete a deployed page by its ID.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            id: { type: "string", description: "The page ID to delete." },
                        },
                        required: ["id"],
                    },
                },
                {
                    name: "deploy_file",
                    description: "Share a local file or folder to the remote server. For a single file, returns a direct download link. For a folder, preserves nested directory structure and returns a share page URL with browse, individual download, zip download, and upload capabilities. Supports drag-and-drop style file sharing.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: {
                                type: "string",
                                description: "Absolute path to the local file or folder to share.",
                            },
                            name: {
                                type: "string",
                                description: "Optional display name for the share.",
                            },
                        },
                        required: ["path"],
                    },
                },
            ],
        };
    });
    // Call tool
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            let text;
            switch (name) {
                case "deploy_html": {
                    const { value, name: pageName, description } = args;
                    text = await client.deployHtml(value, pageName, description);
                    break;
                }
                case "deploy_folder": {
                    const { path, name: pageName, description } = args;
                    text = await client.deployFolder(path, pageName, description);
                    break;
                }
                case "list_pages": {
                    const { limit, offset } = args;
                    text = await client.listPages(limit, offset);
                    break;
                }
                case "delete_page": {
                    const { id } = args;
                    text = await client.deletePage(id);
                    break;
                }
                case "deploy_file": {
                    const { path, name } = args;
                    text = await client.deployFile(path, name);
                    break;
                }
                default:
                    return {
                        content: [{ type: "text", text: `Unknown tool: ${name}` }],
                        isError: true,
                    };
            }
            return { content: [{ type: "text", text }] };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`📡 Pages MCP stdio client connected to ${remoteUrl}`);
}
//# sourceMappingURL=stdio-server.js.map