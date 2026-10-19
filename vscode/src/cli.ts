#!/usr/bin/env node
// Command-line Scry client for agents and scripts. Shares config, protocol and transport code
// with the VS Code extension; bundled into a single file by `npm run build:cli`.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { evalRequest } from "./client.js";
import { resolveEndpoint } from "./config.js";
import { evaluateWithLog, redactedToken } from "./evaluation-log.js";
import { findMixRoot, loadProjectConfig } from "./project.js";

const usage = `Usage:
  scry-cli [--project <dir-or-file>] targets
  scry-cli [--project <dir-or-file>] eval --environment <name> --service <name> --code-file <file|->
           [--host <host>] [--session <id>] [--confirmed]`;

// Returns the exit code: 0 for protocol success, 1 for a server-reported error. Throws for
// configuration and transport failures.
async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string", default: "." },
      environment: { type: "string" },
      service: { type: "string" },
      host: { type: "string" },
      "code-file": { type: "string" },
      session: { type: "string" },
      confirmed: { type: "boolean", default: false },
    },
  });

  const start = path.resolve(values.project);
  const projectRoot = await findMixRoot(statSync(start).isDirectory() ? start : path.dirname(start));
  const { path: configPath, config } = await loadProjectConfig(projectRoot);
  const [command] = positionals;

  if (command === "targets") {
    // Lists what can be targeted without resolving or printing tokens.
    const environments = Object.fromEntries(
      Object.entries(config.environments).map(([name, environment]) => [
        name,
        {
          protocol: environment.protocol,
          requireConfirmation: environment.requireConfirmation,
          targets: Object.fromEntries(
            Object.entries(environment.targets).map(([service, target]) => [service, { hosts: target.hosts, port: target.port }]),
          ),
        },
      ]),
    );
    const listing = { config: configPath, defaultEnvironment: config.defaultEnvironment, applications: config.applications, environments };
    console.log(JSON.stringify(listing, null, 2));
    return 0;
  }
  if (command !== "eval") throw new Error(usage);

  const { environment: environmentName, service, host: requestedHost, "code-file": codeFile, session } = values;
  if (!environmentName || !service || !codeFile) throw new Error(`eval requires --environment, --service and --code-file\n${usage}`);

  const application = config.applications.find((candidate) => candidate.service === service);
  if (!application) throw new Error(`Service ${JSON.stringify(service)} is not a configured application`);
  const endpoint = resolveEndpoint(config, environmentName, application, process.env);
  if (endpoint.requireConfirmation && !values.confirmed) {
    throw new Error("Environment requires user confirmation; obtain it before using --confirmed");
  }
  if (requestedHost === undefined && endpoint.hosts.length !== 1) {
    throw new Error("Multiple hosts configured; choose one with --host");
  }
  const host = requestedHost ?? endpoint.hosts[0];
  if (host === undefined || !endpoint.hosts.includes(host)) {
    throw new Error("Host is not configured for this service/environment");
  }
  if (endpoint.protocol === "xrpc" && session !== undefined) {
    throw new Error("XRPC does not support persistent sessions");
  }

  const code = readFileSync(codeFile === "-" ? 0 : codeFile, "utf8");
  if (code.trim() === "") throw new Error("Code must not be empty");

  const request = evalRequest(endpoint, session ?? randomUUID(), code);
  const sessionId = endpoint.protocol === "scry" ? request.sessionId : null;
  process.stderr.write(`Evaluating ${environmentName}/${service} at ${host}:${endpoint.port} (${endpoint.protocol})\n`);

  const { response, logPath } = await evaluateWithLog({
    configDirectory: path.dirname(configPath),
    header: {
      Environment: environmentName,
      Service: service,
      Host: `${host}:${endpoint.port}`,
      Protocol: endpoint.protocol,
      Session: sessionId ?? "none",
      Confirmed: values.confirmed ? "yes" : "no",
    },
    request,
    target: { host, port: endpoint.port, timeoutMs: endpoint.timeoutMs },
    protocol: endpoint.protocol,
  });

  const output = JSON.stringify({ environment: environmentName, service, host, sessionId, log: logPath, response }, null, 2);
  // JSON escapes characters independently, so the escaped token appears verbatim in the output.
  console.log(output.replaceAll(JSON.stringify(endpoint.token).slice(1, -1), redactedToken));
  return response.status === "ok" ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Scry client failed: ${message}\nIf a request was sent, it may have executed; do not automatically retry.\n`,
    );
    process.exitCode = 2;
  },
);
