import crypto from "crypto";
/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        // Still do a comparison to avoid leaking length info
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}
/**
 * Middleware: require Bearer token in Authorization header.
 * Tokens are validated against the database (multi-token support).
 * Uses constant-time comparison to prevent timing attacks.
 */
export function bearerAuth(db) {
    return async (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            res.status(401).json({ error: "Missing or invalid Authorization header" });
            return;
        }
        const provided = authHeader.slice(7);
        try {
            const token = await db.getTokenByValue(provided);
            // Constant-time comparison: always compare against a dummy value
            const storedToken = token ? token.token : "";
            const isValid = safeEqual(provided, storedToken);
            if (!isValid || !token) {
                // Same response whether token doesn't exist or doesn't match
                res.status(401).json({ error: "Invalid token" });
                return;
            }
            // Update last_used_at (fire and forget)
            db.updateTokenLastUsed(provided);
            next();
        }
        catch (err) {
            res.status(500).json({ error: "Auth check failed" });
        }
    };
}
/**
 * Middleware: require Basic auth (username:password).
 * Uses constant-time comparison to prevent timing attacks.
 */
export function basicAuth(username, password) {
    return (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Basic ")) {
            res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const decoded = Buffer.from(authHeader.slice(6), "utf-8").toString("utf-8");
        const colonIdx = decoded.indexOf(":");
        if (colonIdx === -1) {
            res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
            res.status(401).json({ error: "Invalid credentials" });
            return;
        }
        const user = decoded.substring(0, colonIdx);
        const pass = decoded.substring(colonIdx + 1);
        // Constant-time comparison for both username and password
        const userValid = safeEqual(user, username);
        const passValid = safeEqual(pass, password);
        if (!userValid || !passValid) {
            res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
            res.status(401).json({ error: "Invalid credentials" });
            return;
        }
        next();
    };
}
//# sourceMappingURL=auth.js.map