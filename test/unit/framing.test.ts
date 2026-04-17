import { describe, it, expect } from "vitest";
import { encodeMessage, FrameParser } from "../../src/lsp/framing.js";

describe("FrameParser", () => {
  it("parses single frame", () => {
    const parser = new FrameParser();
    const msg = { jsonrpc: "2.0", id: 1, method: "test" };
    const frame = encodeMessage(msg);
    const parsed = parser.feed(frame);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(msg);
  });

  it("parses multiple frames in one feed", () => {
    const parser = new FrameParser();
    const a = encodeMessage({ id: 1 });
    const b = encodeMessage({ id: 2 });
    const combined = Buffer.concat([a, b]);
    const parsed = parser.feed(combined);
    expect(parsed).toHaveLength(2);
  });

  it("handles partial frames across feeds", () => {
    const parser = new FrameParser();
    const frame = encodeMessage({ id: 1, text: "hello" });
    const mid = Math.floor(frame.length / 2);
    const first = parser.feed(frame.subarray(0, mid));
    expect(first).toHaveLength(0);
    const second = parser.feed(frame.subarray(mid));
    expect(second).toHaveLength(1);
    expect((second[0] as { text: string }).text).toBe("hello");
  });

  it("uses byte length for multibyte UTF-8", () => {
    const parser = new FrameParser();
    const msg = { text: "café 🎉 日本語" };
    const frame = encodeMessage(msg);
    const parsed = parser.feed(frame);
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as { text: string }).text).toBe("café 🎉 日本語");
  });

  it("encodes with correct Content-Length header", () => {
    const msg = { a: 1 };
    const frame = encodeMessage(msg);
    const frameStr = frame.toString("utf8");
    const match = /Content-Length: (\d+)\r\n\r\n/.exec(frameStr);
    expect(match).not.toBeNull();
    const length = parseInt(match![1], 10);
    const body = JSON.stringify(msg);
    expect(Buffer.byteLength(body, "utf8")).toBe(length);
  });
});
