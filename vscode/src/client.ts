import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { ResolvedEndpoint } from "./config.js";
import { encodeFrame, FrameDecoder, type EvalRequest, type ScryRequest, type ScryResponse } from "./protocol.js";
import { encodeXrpcEval, XrpcResponseDecoder } from "./xrpc-protocol.js";

export interface ConnectionTarget {
  host: string;
  port: number;
  timeoutMs: number;
}

export type WireProtocol = "scry" | "xrpc";

export interface SendHooks {
  // Runs once connected, right before the request is written. Throwing aborts without sending.
  beforeSend?: () => void;
}

interface ResponseDecoder {
  push(chunk: Buffer): ScryResponse | undefined;
}

export function evalRequest(endpoint: ResolvedEndpoint, sessionId: string, code: string): EvalRequest {
  return {
    version: 1,
    operation: "eval",
    requestId: randomUUID(),
    sessionId,
    token: endpoint.token,
    service: endpoint.service,
    code,
  };
}

export function sendEvalRequest(
  target: ConnectionTarget,
  request: EvalRequest,
  protocol: WireProtocol,
  hooks: SendHooks = {},
): Promise<ScryResponse> {
  if (protocol === "xrpc") {
    return send(target, request, () => encodeXrpcEval(request), new XrpcResponseDecoder(request.requestId), hooks);
  }
  return send(target, request, () => encodeFrame(request), new FrameDecoder(), hooks);
}

export function sendRequest(target: ConnectionTarget, request: ScryRequest): Promise<ScryResponse> {
  return send(target, request, () => encodeFrame(request), new FrameDecoder(), {});
}

// Makes one connection and one request. `timeoutMs` bounds the whole exchange; on timeout or
// disconnect after sending, the request may still have executed.
function send(
  target: ConnectionTarget,
  request: ScryRequest,
  encode: () => Buffer,
  decoder: ResponseDecoder,
  hooks: SendHooks,
): Promise<ScryResponse> {
  return new Promise((resolve, reject) => {
    const wire = encode();
    const socket = createConnection({ host: target.host, port: target.port });
    let settled = false;

    const timer = setTimeout(
      () => finish(() => reject(new Error(`Request to ${target.host}:${target.port} timed out after ${target.timeoutMs} ms`))),
      target.timeoutMs,
    );

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };

    socket.once("connect", () => {
      try {
        hooks.beforeSend?.();
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      socket.write(wire);
    });
    socket.on("data", (chunk) => {
      try {
        const response = decoder.push(chunk);
        if (!response) return;
        if (response.requestId !== null && response.requestId !== request.requestId) {
          throw new Error("Server response does not match the request");
        }
        finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("close", () => finish(() => reject(new Error("Connection closed without a response"))));
  });
}
