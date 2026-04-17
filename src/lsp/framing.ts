const HEADER_SEP = "\r\n\r\n";

export function encodeMessage(message: unknown): Buffer {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), body]);
}

export class FrameParser {
  private buffer = Buffer.alloc(0);

  feed(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEP);
      if (headerEnd === -1) break;

      const headerStr = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerStr);
      if (!lengthMatch) {
        // Malformed header — skip past separator
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEP.length);
        continue;
      }

      const contentLength = parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + HEADER_SEP.length;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      messages.push(JSON.parse(body));
    }

    return messages;
  }
}
