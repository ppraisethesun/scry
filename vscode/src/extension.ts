import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { sendRequest } from "./client.js";
import {
  findApplication,
  parseConfig,
  resolveEndpoint,
  type ResolvedEndpoint,
  type ScryApplication,
  type ScryConfig,
} from "./config.js";
import type { EvalRequest, ScryRequest, ScryResponse } from "./protocol.js";
import { findElixirProjectRoot } from "./project.js";
import { escapeHtml, responseText } from "./render.js";

interface ProjectContext {
  config: ScryConfig;
  application: ScryApplication;
  workspaceKey: string;
}

interface LastEvaluation {
  code: string;
  header: string;
  output: "inline" | "panel";
  environmentName: string;
  host?: string;
  everywhere: boolean;
}

let lastEvaluation: LastEvaluation | undefined;

export function activate(extensionContext: vscode.ExtensionContext): void {
  const commands: Record<string, () => Promise<void>> = {
    "scry.eval": () => evaluate(extensionContext, { output: "inline" }),
    "scry.evalInPanel": () => evaluate(extensionContext, { output: "panel" }),
    "scry.pickTargetAndEval": () => evaluate(extensionContext, { output: "inline", pickTarget: true }),
    "scry.evalEverywhere": () => evaluate(extensionContext, { output: "inline", everywhere: true }),
    "scry.repeatLastEval": () => repeatLast(extensionContext),
    "scry.changeEnvironment": () => changeEnvironment(extensionContext),
    "scry.clearSession": () => clearSession(extensionContext),
  };

  for (const [command, handler] of Object.entries(commands)) {
    extensionContext.subscriptions.push(
      vscode.commands.registerCommand(command, () => handler().catch(showError)),
    );
  }
}

interface EvaluateOptions {
  output: "inline" | "panel";
  pickTarget?: boolean;
  everywhere?: boolean;
  repeated?: LastEvaluation;
}

async function evaluate(extensionContext: vscode.ExtensionContext, options: EvaluateOptions): Promise<void> {
  const editor = requireEditor();
  const project = await loadProject(editor);
  const source = options.repeated ?? selectedCode(editor);
  let environmentName =
    options.repeated?.environmentName ?? (await activeEnvironment(extensionContext, project));
  let pickedHost = options.repeated?.host;

  if (options.pickTarget) {
    const picked = await pickTarget(project);
    if (!picked) return;
    environmentName = picked.environmentName;
    pickedHost = picked.host;
    await rememberEnvironment(extensionContext, project, environmentName);
  }

  const endpoint = resolveEndpoint(
    project.config,
    environmentName,
    project.application,
    process.env,
  );

  if (!(await confirmIfRequired(endpoint))) return;

  const sessionId = await workspaceSessionId(extensionContext, project);
  const hosts = options.everywhere || options.repeated?.everywhere
    ? endpoint.hosts
    : [pickedHost ?? endpoint.hosts[0]].filter((host): host is string => host !== undefined);

  lastEvaluation = {
    code: source.code,
    header: source.header,
    output: options.output,
    environmentName,
    ...(pickedHost ? { host: pickedHost } : {}),
    everywhere: options.everywhere ?? options.repeated?.everywhere ?? false,
  };

  const responses = await Promise.all(
    hosts.map(async (host) => {
      try {
        return {
          host,
          response: await sendRequest(
            { host, port: endpoint.port, timeoutMs: endpoint.timeoutMs },
            evalRequest(endpoint, sessionId, source.code),
          ),
        };
      } catch (error) {
        return {
          host,
          response: {
            version: 1 as const,
            requestId: null,
            status: "error" as const,
            error: error instanceof Error ? error.message : String(error),
            output: "",
            diagnostics: [],
          },
        };
      }
    }),
  );

  await displayResponses(editor, project.config, source.header, options.output, responses);
}

async function repeatLast(extensionContext: vscode.ExtensionContext): Promise<void> {
  if (!lastEvaluation) throw new Error("No Scry evaluation to repeat");
  await evaluate(extensionContext, { output: lastEvaluation.output, repeated: lastEvaluation });
}

async function changeEnvironment(extensionContext: vscode.ExtensionContext): Promise<void> {
  const editor = requireEditor();
  const project = await loadProject(editor);
  const environmentName = await vscode.window.showQuickPick(Object.keys(project.config.environments), {
    placeHolder: "Select Scry environment",
  });
  if (!environmentName) return;
  await rememberEnvironment(extensionContext, project, environmentName);
  vscode.window.setStatusBarMessage(`Scry environment: ${environmentName}`, 4_000);
}

async function clearSession(extensionContext: vscode.ExtensionContext): Promise<void> {
  const editor = requireEditor();
  const project = await loadProject(editor);
  const environmentName = await activeEnvironment(extensionContext, project);
  const endpoint = resolveEndpoint(project.config, environmentName, project.application, process.env);
  if (!(await confirmIfRequired(endpoint))) return;

  const sessionId = await workspaceSessionId(extensionContext, project);
  const responses = await Promise.all(
    endpoint.hosts.map((host) =>
      sendRequest(
        { host, port: endpoint.port, timeoutMs: endpoint.timeoutMs },
        {
          version: 1,
          operation: "clearSession",
          requestId: randomUUID(),
          sessionId,
          token: endpoint.token,
          service: endpoint.service,
        },
      ),
    ),
  );

  const failure = responses.find((response) => response.status === "error");
  if (failure?.status === "error") throw new Error(failure.error);
  vscode.window.showInformationMessage("Scry session cleared");
}

async function loadProject(editor: vscode.TextEditor): Promise<ProjectContext> {
  const projectRoot = await findElixirProjectRoot(editor.document.uri.fsPath);
  const config = parseConfig(await readProjectConfig(projectRoot));
  const relativeFilePath = path.relative(projectRoot, editor.document.uri.fsPath);

  return {
    config,
    application: findApplication(config, relativeFilePath),
    workspaceKey: vscode.Uri.file(projectRoot).toString(),
  };
}

async function readProjectConfig(workspaceRoot: string): Promise<string> {
  for (const filename of [".scry.local.json", ".scry.json"]) {
    try {
      return await readFile(path.join(workspaceRoot, filename), "utf8");
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
  }

  throw new Error("No .scry.local.json or .scry.json found in Elixir project root");
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function activeEnvironment(
  extensionContext: vscode.ExtensionContext,
  project: ProjectContext,
): Promise<string> {
  const key = `environment:${project.workspaceKey}`;
  const remembered = extensionContext.workspaceState.get<string>(key);
  return remembered && remembered in project.config.environments
    ? remembered
    : project.config.defaultEnvironment;
}

async function rememberEnvironment(
  extensionContext: vscode.ExtensionContext,
  project: ProjectContext,
  environmentName: string,
): Promise<void> {
  await extensionContext.workspaceState.update(`environment:${project.workspaceKey}`, environmentName);
}

async function workspaceSessionId(
  extensionContext: vscode.ExtensionContext,
  project: ProjectContext,
): Promise<string> {
  const key = `session:${project.workspaceKey}`;
  const existing = extensionContext.workspaceState.get<string>(key);
  if (existing) return existing;

  const sessionId = randomUUID();
  await extensionContext.workspaceState.update(key, sessionId);
  return sessionId;
}

async function pickTarget(
  project: ProjectContext,
): Promise<{ environmentName: string; host: string } | undefined> {
  const targets = Object.entries(project.config.environments).flatMap(([environmentName, environment]) => {
    const endpoint = resolveEndpoint(
      project.config,
      environmentName,
      project.application,
      process.env,
    );
    return endpoint.hosts.map((host) => ({ label: `${environmentName}: ${host}`, environmentName, host }));
  });

  return vscode.window.showQuickPick(targets, { placeHolder: "Select Scry target" });
}

async function confirmIfRequired(endpoint: ResolvedEndpoint): Promise<boolean> {
  if (!endpoint.requireConfirmation) return true;

  const answer = await vscode.window.showWarningMessage(
    `Evaluate code in ${endpoint.environmentName}/${endpoint.service}?`,
    { modal: true },
    "Evaluate",
  );
  return answer === "Evaluate";
}

function evalRequest(endpoint: ResolvedEndpoint, sessionId: string, code: string): EvalRequest {
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

function selectedCode(editor: vscode.TextEditor): { code: string; header: string } {
  const code = editor.selection.isEmpty
    ? editor.document.getText().trim()
    : editor.document.getText(editor.selection).trim();
  if (code === "") throw new Error("No Elixir code to evaluate");

  return { code, header: code.split("\n", 1)[0]?.slice(0, 80) ?? "eval" };
}

async function displayResponses(
  editor: vscode.TextEditor,
  config: ScryConfig,
  header: string,
  output: "inline" | "panel",
  responses: Array<{ host: string; response: ScryResponse }>,
): Promise<void> {
  const failures = responses.filter(
    (item): item is { host: string; response: Extract<ScryResponse, { status: "error" }> } =>
      item.response.status === "error",
  );
  if (failures.length > 0) {
    throw new Error(
      failures.map(({ host, response }) => `${host}: ${responseText(response)}`).join("\n\n"),
    );
  }

  const moduleResponses = responses.filter(
    ({ response }) => response.status === "ok" && response.kind === "module",
  );
  if (moduleResponses.length === responses.length) {
    vscode.window.showInformationMessage(moduleResponses.map(({ response }) => responseText(response)).join("; "));
    return;
  }

  const text = responses
    .map(({ host, response }) => `${responses.length > 1 ? `[${host}]\n` : ""}${responseText(response)}`)
    .join("\n\n");

  if (output === "panel" || text.length > config.resultThreshold) {
    const panel = vscode.window.createWebviewPanel("scryResult", "Scry result", vscode.ViewColumn.Beside);
    panel.webview.html = `<!doctype html><html><body><pre>${escapeHtml(text)}</pre></body></html>`;
    return;
  }

  await editor.edit((editBuilder) => {
    const selectedLine = editor.document.lineAt(editor.selection.end.line);
    const insertionPosition = selectedLine.rangeIncludingLineBreak.end;
    const leadingNewline = insertionPosition.isEqual(selectedLine.range.end) ? "\n" : "";
    const indentation =
      editor.document.lineAt(editor.selection.start.line).text.match(/^\s*/)?.[0] ?? "";
    const bodyIndentation = `${indentation}  `;
    const body = text
      .split("\n")
      .map((part) => `${bodyIndentation}${part}`)
      .join("\n")
      .trimEnd();

    editBuilder.insert(
      insertionPosition,
      `${leadingNewline}${indentation}\"\"\"\n${bodyIndentation}@scry: ${header}\n${body}\n${indentation}\"\"\"\n`,
    );
  });
}

function requireEditor(): vscode.TextEditor {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error("No active editor");
  return editor;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showErrorMessage(`Scry: ${message}`);
}

export function deactivate(): void {}
