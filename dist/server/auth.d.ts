import type { Request, Response, NextFunction } from "express";
import { PagesDatabase } from "./db.js";
/**
 * Middleware: require Bearer token in Authorization header.
 * Tokens are validated against the database (multi-token support).
 * Uses constant-time comparison to prevent timing attacks.
 */
export declare function bearerAuth(db: PagesDatabase): (req: Request, res: Response, next: NextFunction) => Promise<void>;
/**
 * Middleware: require Basic auth (username:password).
 * Uses constant-time comparison to prevent timing attacks.
 */
export declare function basicAuth(username: string, password: string): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=auth.d.ts.map