import { encodeMessage, FrameParser } from "./framing.js";
const REQUEST_TIMEOUT_MS = parseInt(process.env.LSP_MCP_REQUEST_TIMEOUT_MS ?? "30000", 10);
export class LspClient {
    proc;
    nextId = 1;
    pending = new Map();
    parser = new FrameParser();
    notificationHandlers = [];
    constructor(proc) {
        this.proc = proc;
        proc.stdout.on("data", (chunk) => {
            for (const msg of this.parser.feed(chunk)) {
                this.dispatch(msg);
            }
        });
    }
    onNotification(handler) {
        this.notificationHandlers.push(handler);
    }
    request(method, params) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject({ code: "lsp_timeout", method });
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: resolve,
                reject,
                timer,
            });
            this.proc.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
        });
    }
    notify(method, params) {
        this.proc.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
    }
    dispatch(msg) {
        if ("id" in msg && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id);
            clearTimeout(entry.timer);
            this.pending.delete(msg.id);
            if ("error" in msg) {
                entry.reject(msg.error);
            }
            else {
                entry.resolve(msg.result);
            }
        }
        else if (!("id" in msg) && "method" in msg) {
            for (const h of this.notificationHandlers) {
                h(msg.method, msg.params);
            }
        }
    }
    get childProcess() {
        return this.proc;
    }
}
//# sourceMappingURL=client.js.map