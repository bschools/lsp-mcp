import { ChildProcess } from "node:child_process";
import { encodeMessage, FrameParser } from "./framing.js";

const REQUEST_TIMEOUT_MS = parseInt(
  process.env.LSP_MCP_REQUEST_TIMEOUT_MS ?? "30000",
  10,
);

export type NotificationHandler = (method: string, params: unknown) => void;

/**
 * Handles a server→client request. Return the JSON-RPC `result` to answer with.
 * Every server request MUST be answered — an unanswered request leaves the
 * server awaiting a reply it never gets (this is how the tsserver progress
 * reporter stalls, see lifecycle's project-load tracking).
 */
export type RequestHandler = (method: string, params: unknown) => unknown;

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
  private requestHandler: RequestHandler | undefined;

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

  /** Install the handler for server→client requests. Last call wins. */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
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
    // Shape before id: the two directions have independent id spaces, so a
    // server→client request can carry an id that is also in flight from this
    // side. Only a message WITHOUT `method` can be a response to us.
    if (!("method" in msg) && "id" in msg && this.pending.has(msg.id as number)) {
      const entry = this.pending.get(msg.id as number)!;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id as number);

      if ("error" in msg) {
        entry.reject(msg.error);
      } else {
        entry.resolve(msg.result);
      }
    } else if ("id" in msg && "method" in msg) {
      // Server→client request. Answering is mandatory: tsserver's progress
      // reporter awaits the reply to `window/workDoneProgress/create` before
      // it will emit any begin/end progress, so dropping these silently
      // suppresses the project-load signal entirely.
      let result: unknown = null;
      try {
        result = this.requestHandler?.(msg.method as string, msg.params) ?? null;
      } catch {
        result = null;
      }
      this.proc.stdin!.write(
        encodeMessage({ jsonrpc: "2.0", id: msg.id, result }),
      );
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
