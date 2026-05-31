import { PagesDatabase } from "./db.js";
import { FileStorage } from "./storage.js";
import type { ServerConfig } from "../shared/types.js";
export declare function createApp(config: ServerConfig): {
    app: any;
    db: PagesDatabase;
    storage: FileStorage;
};
//# sourceMappingURL=app.d.ts.map