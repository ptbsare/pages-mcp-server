import type { DeployedPage, AuthToken } from "../shared/types.js";
export declare class PagesDatabase {
    private db;
    private dbPath;
    private initialized;
    constructor(dbPath: string);
    private ensureDb;
    private init;
    private save;
    createPage(page: DeployedPage): Promise<void>;
    getPageByShareId(shareId: string): Promise<DeployedPage | undefined>;
    getPageById(id: string): Promise<DeployedPage | undefined>;
    listPages(limit?: number, offset?: number): Promise<{
        pages: DeployedPage[];
        total: number;
    }>;
    updatePage(id: string, updates: {
        name?: string;
        description?: string;
    }): Promise<boolean>;
    deletePage(id: string): Promise<boolean>;
    private rowToPage;
    createToken(token: AuthToken): Promise<void>;
    getTokenByValue(tokenValue: string): Promise<AuthToken | undefined>;
    listTokens(): Promise<AuthToken[]>;
    deleteToken(id: string): Promise<boolean>;
    updateTokenLastUsed(tokenValue: string): Promise<void>;
    tokenExists(tokenValue: string): Promise<boolean>;
    private rowToAuthToken;
    close(): void;
}
//# sourceMappingURL=db.d.ts.map