import { inflateSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { EvalRequest } from "../src/protocol.js";
import { encodeXrpcEval, XrpcResponseDecoder } from "../src/xrpc-protocol.js";

const request: EvalRequest = {
  version: 1,
  operation: "eval",
  requestId: "request-1",
  sessionId: "session-1",
  token: "secret",
  service: "ms_accounts",
  code: "user = Repo.get!(User, 42)",
};

describe("original XRPC debug socket protocol", () => {
  it("encodes the deployed server handshake and XRPC wrapper", () => {
    const encoded = encodeXrpcEval(request).toString("utf8");
    const compressedCode = /Base\.decode64!\("([^"]+)"\)/.exec(encoded)?.[1];

    expect(encoded).toMatch(/^\$\$START_SEND_CODE\$\$: secret\n/);
    expect(encoded).toContain("case XRPC.call(:ms_accounts, Code, :eval_string, [code]) do");
    expect(encoded).toMatch(/\n\$\$END_SEND_CODE\$\$\n$/);
    expect(inflateSync(Buffer.from(compressedCode ?? "", "base64")).toString("utf8")).toBe(request.code);
  });

  it("decodes a fragmented compressed success response", () => {
    const response = Buffer.concat([
      Buffer.from("$$RESULT_OK$$\n$$START_SEND_RESULT$$\n"),
      deflateSync(Buffer.from("%{id: 42}")),
      Buffer.from("\n$$END_SEND_RESULT$$\n"),
    ]);
    const decoder = new XrpcResponseDecoder(request.requestId);

    expect(decoder.push(response.subarray(0, 17))).toBeUndefined();
    expect(decoder.push(response.subarray(17))).toMatchObject({
      status: "ok",
      requestId: "request-1",
      result: "%{id: 42}",
    });
  });

  it("decodes the deployed server error response", () => {
    const response = Buffer.concat([
      Buffer.from("$$RESULT_ERROR$$\n$$START_SEND_RESULT$$\n"),
      deflateSync(Buffer.from("** (RuntimeError) boom")),
      Buffer.from("\n$$END_SEND_RESULT$$\n"),
    ]);

    expect(new XrpcResponseDecoder(request.requestId).push(response)).toMatchObject({
      status: "error",
      error: "** (RuntimeError) boom",
    });
  });
});
