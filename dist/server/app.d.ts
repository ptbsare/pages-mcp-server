declare global {
    var _otpDecryptTokens: Map<string, {
        expiry: number;
        adminUser: string;
    }> | undefined;
}
import { PagesDatabase } from "./db.js";
import { FileStorage } from "./storage.js";
import type { ServerConfig } from "../shared/types.js";
export declare function createApp(config: ServerConfig): {
    app: import("express-serve-static-core").Express;
    db: PagesDatabase;
    storage: FileStorage;
};
//# sourceMappingURL=app.d.ts.map