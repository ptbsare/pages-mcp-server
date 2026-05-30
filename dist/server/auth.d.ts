import type { Request, Response, NextFunction } from "express";
import { PagesDatabase } from "./db.js";
/**
 * Middleware: require Bearer token in Authorization header.
 * Tokens are validated against the database (multi-token support).
 * Used for MCP endpoint and deploy API.
 */
export declare function bearerAuth(db: PagesDatabase): (req: Request, res: Response, next: NextFunction) => Promise<void>;
/**
 * Middleware: require Basic auth (username:password).
 * Used for admin panel.
 */
export declare function basicAuth(username: string, password: string): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=auth.d.ts.map