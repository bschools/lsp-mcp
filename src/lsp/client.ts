import { ChildProcess } from "node:child_process";
import { encodeMessage, FrameParser } from "./framing.js";

const REQUEST_TIMEOUT_MS = parseInt(
  process.env.LSP_MCP_REQUEST_TIMEOUT_MS ?? "30000",
  10,
);

export type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private parser = new FrameParser();
  private notificationHandlers: NotificationHandler[] = [];

  constructor(private readonly proc: ChildProcess) {
    proc.stdout!.on("data", (chunk: Buffer) => {
      for (const msg of this.parser.feed(chunk)) {
        this.dispatch(msg as Record<string, unknown>);
      }
    });
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: "lsp_timeout", method });
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.proc.stdin!.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin!.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  private dispatch(msg: Record<string, unknown>): void {
    if ("id" in msg && this.pending.has(msg.id as number)) {
      const entry = this.pending.get(msg.id as number)!;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id as number);

      if ("error" in msg) {
        entry.reject(msg.error);
      } else {
        entry.resolve(msg.result);
      }
    } else if (!("id" in msg) && "method" in msg) {
      for (const h of this.notificationHandlers) {
        h(msg.method as string, msg.params);
      }
    }
  }

  get childProcess(): ChildProcess {
    return this.proc;
  }
}
