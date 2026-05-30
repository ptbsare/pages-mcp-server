// ============================================================
// Shared types between server and client
// ============================================================
/** Build a public URL with port if non-standard */
export function buildUrl(domain, port) {
    try {
        const url = new URL(domain);
        const isDefaultPort = (url.protocol === "https:" && port === 443) || (url.protocol === "http:" && port === 80);
        if (!isDefaultPort && !url.port) {
            url.port = String(port);
        }
        return url.toString().replace(/\/$/, "");
    }
    catch {
        return domain;
    }
}
//# sourceMappingURL=types.js.map