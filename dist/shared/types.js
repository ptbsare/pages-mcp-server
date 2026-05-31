// ============================================================
// Shared types between server and client
// ============================================================
/** Build a public URL with external port if non-standard */
export function buildUrl(domain, outPort) {
    try {
        const url = new URL(domain);
        const isDefaultPort = (url.protocol === "https:" && outPort === 443) || (url.protocol === "http:" && outPort === 80);
        if (!isDefaultPort && !url.port) {
            url.port = String(outPort);
        }
        return url.toString().replace(/\/$/, "");
    }
    catch {
        return domain;
    }
}
//# sourceMappingURL=types.js.map