import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { sendEvalRequest, type ConnectionTarget, type WireProtocol } from "./client.js";
import type { EvalRequest, ScryResponse } from "./protocol.js";

const redactedToken = "[REDACTED SCRY TOKEN]";

type Outcome = "connection_error" | "unknown" | ScryResponse["status"];

// Replaces the token, raw or JSON-escaped, wherever server data or errors may echo it.
export function redact(text: string, token: string): string {
  return text.replaceAll(token, redactedToken).replaceAll(JSON.stringify(token).slice(1, -1), redactedToken);
}

export interface LoggedEvaluation {
  // Directory holding the Scry config; logs go to `.scry-history/` inside it.
  configDirectory: string;
  // Target description written at the top of the log, e.g. Environment, Service, Host.
  header: Record<string, string>;
  request: EvalRequest;
  target: ConnectionTarget;
  protocol: WireProtocol;
}

// Sends one evaluation for the CLI, recording each stage in a Markdown log. The code is logged
// before connecting, so a failed initial write prevents the request. Outcomes: `connection_error`
// (nothing sent), `unknown` (sending began without a valid response), or the response status.
// A failure to write the final outcome is reported on stderr and never hides the response.
export async function evaluateWithLog(evaluation: LoggedEvaluation): Promise<{ response: ScryResponse; logPath: string }> {
  const { configDirectory, header, request, target, protocol } = evaluation;
  const started = new Date();
  const logPath = createLogFile(configDirectory, started, request.requestId);
  const append = (text: string): void => appendLog(logPath, text, request.token);

  const fields = { Started: started.toISOString(), Project: configDirectory, ...header, Request: request.requestId, State: "connecting" };
  append(
    "# Scry evaluation\n\n" +
      Object.entries(fields).map(([name, value]) => `${name}: ${value}\n`).join("") +
      markdownBlock("Code", request.code, "elixir"),
  );
  process.stderr.write(`Evaluation log: ${logPath}\n`);

  let outcome: Outcome = "connection_error";
  let details = "";
  try {
    const response = await sendEvalRequest(target, request, protocol, {
      beforeSend: () => {
        append("\nState: unknown (sending; execution may occur)\n");
        outcome = "unknown";
      },
    });
    outcome = response.status;
    details = responseDetails(response);
    return { response, logPath };
  } catch (error) {
    // Parse errors can quote server bytes, so the message is redacted before it reaches stderr.
    const message = redact(error instanceof Error ? error.message : String(error), request.token);
    details = markdownBlock("clientError", message);
    throw new Error(message);
  } finally {
    try {
      append(`\nFinished: ${new Date().toISOString()}\nOutcome: ${outcome}\n${details}`);
    } catch (error) {
      process.stderr.write(`Warning: could not finalize evaluation log (${error instanceof Error ? error.message : error})\n`);
    }
  }
}

function createLogFile(configDirectory: string, started: Date, requestId: string): string {
  const directory = path.join(configDirectory, ".scry-history");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Keep runtime logs out of Git without touching the project's ignore rules.
  const ignore = path.join(directory, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  const stamp = started.toISOString().replaceAll(/[-:]/g, "");
  const logPath = path.join(directory, `${stamp}-${requestId}.md`);
  closeSync(openSync(logPath, "wx", 0o600));
  return logPath;
}

// Appends and fsyncs, so each stage is on disk before the client proceeds.
function appendLog(logPath: string, text: string, token: string): void {
  const descriptor = openSync(logPath, "a");
  try {
    writeSync(descriptor, redact(text, token));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function responseDetails(response: ScryResponse): string {
  let details = response.status === "ok" ? markdownBlock("result", response.result) : markdownBlock("error", response.error);
  if (response.output) details += markdownBlock("output", response.output);
  if (response.diagnostics.length > 0) {
    details += markdownBlock("Diagnostics", JSON.stringify(response.diagnostics, null, 2), "json");
  }
  return details;
}

// Fenced block whose fence outgrows any backtick run inside the text.
function markdownBlock(label: string, text: string, language = ""): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `\n## ${label}\n\n${fence}${language}\n${text}\n${fence}\n`;
}
