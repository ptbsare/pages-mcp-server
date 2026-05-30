import type { Request, Response, NextFunction } from "express";

/**
 * Middleware: require Bearer token in Authorization header.
 * Used for MCP endpoint and deploy API.
 */
export function bearerAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }
    const provided = authHeader.slice(7);
    if (provided !== token) {
      res.status(403).json({ error: "Invalid token" });
      return;
    }
    next();
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
