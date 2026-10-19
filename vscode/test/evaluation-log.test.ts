import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWithLog, redactedToken } from "../src/evaluation-log.js";
import type { EvalRequest } from "../src/protocol.js";
import { reply, serve } from "./server.js";

const request: EvalRequest = {
  version: 1,
  operation: "eval",
  requestId: "request-1",
  sessionId: "session-1",
  token: "secret-token",
  service: "accounts",
  code: 'inspect("secret-token")',
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function configDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "scry-log-"));
  directories.push(directory);
  return directory;
}

function logPath(directory: string): string {
  const history = path.join(directory, ".scry-history");
  const [name] = readdirSync(history).filter((file) => file.endsWith(".md"));
  if (!name) throw new Error("No evaluation log written");
  return path.join(history, name);
}

function evaluate(directory: string, port: number) {
  return evaluateWithLog({
    configDirectory: directory,
    header: { Environment: "staging", Service: "accounts", Confirmed: "no" },
    request,
    target: { host: "127.0.0.1", port, timeoutMs: 1_000 },
    protocol: "scry",
  });
}

describe("evaluation log", () => {
  it("records each stage and redacts the token", async () => {
    const directory = configDirectory();
    let logWhileSending = "";
    const port = await serve((socket) =>
      socket.once("data", () => {
        logWhileSending = readFileSync(logPath(directory), "utf8");
        socket.write(reply("request-1"));
      }),
    );

    const { response, logPath: written } = await evaluate(directory, port);

    const log = readFileSync(written, "utf8");
    expect(response.status).toBe("ok");
    expect(logWhileSending).toContain("State: unknown");
    expect(log).toContain("```elixir");
    expect(log).toContain("Confirmed: no");
    expect(log).toContain("Outcome: ok");
    expect(log).not.toContain("secret-token");
    expect(log).toContain(redactedToken);
    expect(statSync(written).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(directory, ".scry-history", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("records a connection failure as nothing sent", async () => {
    const directory = configDirectory();

    // Nothing listens on port 1, so the connection is refused.
    await expect(evaluate(directory, 1)).rejects.toThrow();

    expect(readFileSync(logPath(directory), "utf8")).toContain("Outcome: connection_error");
  });

  it("returns the response when the final log write fails", async () => {
    const directory = configDirectory();
    const port = await serve((socket) =>
      socket.once("data", () => {
        chmodSync(logPath(directory), 0o400);
        socket.write(reply("request-1"));
      }),
    );

    const { response } = await evaluate(directory, port);

    expect(response.status).toBe("ok");
  });
});
