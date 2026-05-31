import type { ServerConfig } from "../shared/types.js";
export declare function startServer(config?: Partial<ServerConfig>): {
    server: any;
    app: any;
    db: import("./db.js").PagesDatabase;
    storage: import("./storage.js").FileStorage;
};
//# sourceMappingURL=index.d.ts.map