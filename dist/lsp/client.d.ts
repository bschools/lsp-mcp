import { ChildProcess } from "node:child_process";
export type NotificationHandler = (method: string, params: unknown) => void;
export declare class LspClient {
    private readonly proc;
    private nextId;
    private pending;
    private parser;
    private notificationHandlers;
    constructor(proc: ChildProcess);
    onNotification(handler: NotificationHandler): void;
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
    notify(method: string, params?: unknown): void;
    private dispatch;
    get childProcess(): ChildProcess;
}
//# sourceMappingURL=client.d.ts.map