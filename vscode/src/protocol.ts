export interface EvalRequest {
  version: 1;
  operation: "eval";
  requestId: string;
  sessionId: string;
  token: string;
  service: string;
  code: string;
}

export interface ClearSessionRequest {
  version: 1;
  operation: "clearSession";
  requestId: string;
  sessionId: string;
  token: string;
  service: string;
}

export type ScryRequest = EvalRequest | ClearSessionRequest;

export interface Diagnostic {
  severity: string;
  message: string;
  file: string;
  line: number;
  column: number;
}

interface ResponseBase {
  version: 1;
  requestId: string | null;
  output: string;
  diagnostics: Diagnostic[];
}

export interface SuccessResponse extends ResponseBase {
  status: "ok";
  kind: "expression" | "module" | "session";
  result: string;
  loadedModule?: string | undefined;
}

export interface ErrorResponse extends ResponseBase {
  status: "error";
  error: string;
}

export type ScryResponse = SuccessResponse | ErrorResponse;

const diagnosticSchema = z.object({
  severity: z.string(),
  message: z.string(),
  file: z.string(),
  line: z.number().int(),
  column: z.number().int(),
});

const responseBase = {
  version: z.literal(1),
  requestId: z.string().nullable(),
  output: z.string(),
  diagnostics: z.array(diagnosticSchema),
};

const responseSchema = z.discriminatedUnion("status", [
  z.object({
    ...responseBase,
    status: z.literal("ok"),
    kind: z.enum(["expression", "module", "session"]),
    result: z.string(),
    loadedModule: z.string().optional(),
  }),
  z.object({
    ...responseBase,
    status: z.literal("error"),
    error: z.string(),
  }),
]);

const maximumResponseBytes = 10 * 1024 * 1024;

export function encodeFrame(value: ScryRequest): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): ScryResponse | undefined {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length < 4) return undefined;

    const length = this.buffered.readUInt32BE(0);
    if (length > maximumResponseBytes) {
      throw new Error(`Scry response exceeds ${maximumResponseBytes} bytes`);
    }
    if (this.buffered.length < length + 4) return undefined;

    const payload = this.buffered.subarray(4, length + 4).toString("utf8");
    return parseResponse(payload);
  }
}

export function parseResponse(payload: string): ScryResponse {
  const value: unknown = JSON.parse(payload);
  const response = responseSchema.safeParse(value);
  if (!response.success) throw new Error("Server returned an invalid Scry response");
  return response.data;
}
import { z } from "zod";
