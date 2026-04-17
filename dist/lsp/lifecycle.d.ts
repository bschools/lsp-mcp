import { LspClient } from "./client.js";
export interface LspLifecycle {
    client: LspClient;
    shutdown(): Promise<void>;
    didOpen(filePath: string): Promise<void>;
    didChange(filePath: string): Promise<void>;
    didClose(filePath: string): Promise<void>;
    ensureFile(filePath: string): Promise<void>;
}
export declare function createLspLifecycle(workspaceRoot: string): Promise<LspLifecycle>;
//# sourceMappingURL=lifecycle.d.ts.map