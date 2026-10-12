import { deflateSync, inflateSync } from "node:zlib";
import type { EvalRequest, ScryResponse } from "./protocol.js";

const okHeader = Buffer.from("$$RESULT_OK$$\n$$START_SEND_RESULT$$\n");
const errorHeader = Buffer.from("$$RESULT_ERROR$$\n$$START_SEND_RESULT$$\n");
const trailer = Buffer.from("\n$$END_SEND_RESULT$$\n");
const maximumResponseBytes = 10 * 1024 * 1024;
const servicePattern = /^[a-z][a-zA-Z0-9_]*$/;

export function encodeXrpcEval(request: EvalRequest): Buffer {
  if (request.token.includes("\n") || request.token.includes("\r")) {
    throw new Error("XRPC token must be a single line");
  }
  if (!servicePattern.test(request.service)) {
    throw new Error(`XRPC service is not a valid unquoted Elixir atom: ${JSON.stringify(request.service)}`);
  }

  const compressedCode = deflateSync(Buffer.from(request.code, "utf8")).toString("base64");

  return Buffer.from(
    [
      `$$START_SEND_CODE$$: ${request.token}`,
      `zipped_code = Base.decode64!("${compressedCode}")`,
      "code = :zlib.uncompress(zipped_code)",
      `case XRPC.call(:${request.service}, Code, :eval_string, [code]) do`,
      "  {:error, err} -> inspect(err, pretty: true, limit: :infinity, printable_limit: :infinity)",
      "  {{:module, module_name, _, _}, _} ->",
      '    "<<module loaded success>>"',
      "  {res, bindings} ->",
      "    inspect(res, pretty: true, limit: :infinity, printable_limit: :infinity)",
      "  otherwise ->",
      "    inspect(otherwise, pretty: true, limit: :infinity, printable_limit: :infinity)",
      "end",
      "$$END_SEND_CODE$$",
      "",
    ].join("\n"),
    "utf8",
  );
}

export class XrpcResponseDecoder {
  private buffered = Buffer.alloc(0);

  constructor(private readonly requestId: string) {}

  push(chunk: Buffer): ScryResponse | undefined {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length > maximumResponseBytes) {
      throw new Error(`XRPC response exceeds ${maximumResponseBytes} bytes`);
    }

    const status = this.status();
    if (!status) return undefined;

    const end = this.buffered.lastIndexOf(trailer);
    if (end === -1) return undefined;

    const compressed = this.buffered.subarray(status.header.length, end);
    const result = inflateSync(compressed, { maxOutputLength: maximumResponseBytes }).toString("utf8");

    if (status.kind === "error") {
      return {
        version: 1,
        requestId: this.requestId,
        status: "error",
        error: result,
        output: "",
        diagnostics: [],
      };
    }

    return {
      version: 1,
      requestId: this.requestId,
      status: "ok",
      kind: "expression",
      result,
      output: "",
      diagnostics: [],
    };
  }

  private status(): { kind: "ok" | "error"; header: Buffer } | undefined {
    if (this.buffered.subarray(0, okHeader.length).equals(okHeader)) {
      return { kind: "ok", header: okHeader };
    }
    if (this.buffered.subarray(0, errorHeader.length).equals(errorHeader)) {
      return { kind: "error", header: errorHeader };
    }

    const bufferedPrefixLength = Math.min(this.buffered.length, errorHeader.length);
    const couldBeOk = okHeader.subarray(0, Math.min(bufferedPrefixLength, okHeader.length)).equals(
      this.buffered.subarray(0, Math.min(bufferedPrefixLength, okHeader.length)),
    );
    const couldBeError = errorHeader.subarray(0, bufferedPrefixLength).equals(
      this.buffered.subarray(0, bufferedPrefixLength),
    );
    if (couldBeOk || couldBeError) return undefined;
    throw new Error("Server returned an invalid XRPC response");
  }
}
