import { describe, expect, it } from "vitest";
import { sendEvalRequest } from "../src/client.js";
import type { EvalRequest } from "../src/protocol.js";
import { reply, serve } from "./server.js";

const request: EvalRequest = {
  version: 1,
  operation: "eval",
  requestId: "request-1",
  sessionId: "session-1",
  token: "secret",
  service: "accounts",
  code: "1 + 2",
};

describe("Scry client", () => {
  it("rejects a response for another request", async () => {
    const port = await serve((socket) => socket.once("data", () => socket.write(reply("other"))));
    await expect(sendEvalRequest({ host: "127.0.0.1", port, timeoutMs: 1_000 }, request, "scry")).rejects.toThrow(
      "does not match",
    );
  });

  it("bounds the whole exchange, not just inactivity", async () => {
    const port = await serve((socket) => {
      // Announce a large frame, then keep the connection busy without completing it.
      const length = Buffer.alloc(4);
      length.writeUInt32BE(1_000);
      socket.write(length);
      const drip = setInterval(() => socket.write(" "), 20);
      socket.once("close", () => clearInterval(drip));
    });
    await expect(sendEvalRequest({ host: "127.0.0.1", port, timeoutMs: 100 }, request, "scry")).rejects.toThrow("timed out");
  });

  it("does not send when beforeSend throws", async () => {
    // Resolves once the client hangs up, reporting whether any request bytes arrived.
    let reportReceived: (received: boolean) => void = () => {};
    const serverSide = new Promise<boolean>((resolve) => (reportReceived = resolve));
    const port = await serve((socket) => {
      let received = false;
      socket.on("data", () => (received = true));
      socket.once("close", () => reportReceived(received));
    });
    const hooks = {
      beforeSend: () => {
        throw new Error("log failed");
      },
    };
    await expect(sendEvalRequest({ host: "127.0.0.1", port, timeoutMs: 1_000 }, request, "scry", hooks)).rejects.toThrow(
      "log failed",
    );
    await expect(serverSide).resolves.toBe(false);
  });
});
