import type { Request, Response, NextFunction } from "express";
import { PagesDatabase } from "./db.js";

/**
 * Middleware: require Bearer token in Authorization header.
 * Tokens are validated against the database (multi-token support).
 * Used for MCP endpoint and deploy API.
 */
export function bearerAuth(db: PagesDatabase) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }
    const provided = authHeader.slice(7);
    try {
      const token = await db.getTokenByValue(provided);
      if (!token) {
        res.status(403).json({ error: "Invalid token" });
        return;
      }
      // Update last_used_at (fire and forget)
      db.updateTokenLastUsed(provided);
      next();
    } catch (err) {
      res.status(500).json({ error: "Auth check failed" });
    }
  };
}

/**
 * Middleware: require Basic auth (username:password).
 * Used for admin panel.
 */
export function basicAuth(username: string, password: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
    const [user, pass] = decoded.split(":");

    if (user !== username || pass !== password) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
      res.status(403).json({ error: "Invalid credentials" });
      return;
    }

    next();
  };
}
