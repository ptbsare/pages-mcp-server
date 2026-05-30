import type { ServerConfig } from "../shared/types.js";
export declare function startServer(config?: Partial<ServerConfig>): {
    server: import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>;
    app: import("express-serve-static-core").Express;
    db: import("./db.js").PagesDatabase;
    storage: import("./storage.js").FileStorage;
};
//# sourceMappingURL=index.d.ts.map