import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, type EvalRequest } from "../src/protocol.js";

const request: EvalRequest = {
  version: 1,
  operation: "eval",
  requestId: "request-1",
  sessionId: "session-1",
  token: "secret",
  service: "accounts",
  code: "1 + 2",
};

describe("Scry protocol", () => {
  it("writes a four-byte length prefix", () => {
    const frame = encodeFrame(request);
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    expect(JSON.parse(frame.subarray(4).toString("utf8"))).toEqual(request);
  });

  it("decodes a fragmented response", () => {
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        requestId: "request-1",
        status: "ok",
        kind: "expression",
        result: "3",
        output: "",
        diagnostics: [],
      }),
    );
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(payload.length);
    payload.copy(frame, 4);

    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 7))).toBeUndefined();
    expect(decoder.push(frame.subarray(7))).toMatchObject({ status: "ok", result: "3" });
  });
});
