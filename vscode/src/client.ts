import { createConnection } from "node:net";
import { encodeFrame, FrameDecoder, type ScryRequest, type ScryResponse } from "./protocol.js";

export interface ConnectionTarget {
  host: string;
  port: number;
  timeoutMs: number;
}

export function sendRequest(target: ConnectionTarget, request: ScryRequest): Promise<ScryResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: target.host, port: target.port });
    const decoder = new FrameDecoder();
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };

    socket.setTimeout(target.timeoutMs);
    socket.once("connect", () => socket.write(encodeFrame(request)));
    socket.on("data", (chunk) => {
      try {
        const response = decoder.push(chunk);
        if (response) finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("timeout", () =>
      finish(() => reject(new Error(`Scry request to ${target.host}:${target.port} timed out`))),
    );
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("close", () => {
      if (!settled) finish(() => reject(new Error("Scry connection closed without a response")));
    });
  });
}
