import { Request, Response } from "express";
import { PagesDatabase } from "./db.js";
import { FileStorage } from "./storage.js";
import type { ServerConfig } from "../shared/types.js";
/**
 * Handle MCP JSON-RPC requests over HTTP at /mcp
 * This implements the Streamable HTTP transport pattern.
 */
export declare function createMcpHandler(config: ServerConfig, db: PagesDatabase, storage: FileStorage): (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=mcp-endpoint.d.ts.map