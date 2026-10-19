import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { evalRequest, sendEvalRequest, sendRequest } from "./client.js";
import { findChangedModules } from "./changed-modules.js";
import {
  findApplication,
  resolveEndpoint,
  type ResolvedEndpoint,
  type ScryApplication,
  type ScryConfig,
} from "./config.js";
import type { EvalRequest, ScryRequest, ScryResponse } from "./protocol.js";
import { findElixirProjectRoot, loadProjectConfig } from "./project.js";
import { escapeHtml, formatDuration, responseText } from "./render.js";

interface ProjectContext {
  config: ScryConfig;
  application: ScryApplication;
  projectRoot: string;
  workspaceKey: string;
}

interface LastEvaluation {
  code: string;
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
    "scry.evalChangedModules": () => evalChangedModules(extensionContext),
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

async function evalChangedModules(extensionContext: vscode.ExtensionContext): Promise<void> {
  const project = await loadProject(requireEditor());
  const modules = await findChangedModules(project.projectRoot);
  if (modules.length === 0) {
    vscode.window.showInformationMessage("Scry: no changed .ex modules found");
    return;
  }

  const environmentName = await activeEnvironment(extensionContext, project);
  const jobs = await Promise.all(
    modules.map(async (module) => {
      const application = findApplication(project.config, module.relativePath);
      const endpoint = resolveEndpoint(project.config, environmentName, application, process.env);
      return { ...module, code: await readFile(module.absolutePath, "utf8"), endpoint };
    }),
  );

  // Derived dependents are opt-in: they come from runtime chains xref cannot
  // see through, so they are usually false positives and can be hundreds.
  const directJobs = jobs.filter(({ reason }) => reason !== "derived");
  const actionDetail = (selected: typeof jobs) =>
    [...new Map(selected.map(({ endpoint }) => [endpoint.service, endpoint])).values()]
      .map((endpoint) => `${endpoint.service} (${endpoint.hosts[0]}:${endpoint.port})`).join(", ");
  const evaluateDirect: vscode.QuickPickItem = {
    label: `$(play) Evaluate ${directJobs.length} changed and dependent modules`,
    detail: actionDetail(directJobs),
    alwaysShow: true,
  };
  const evaluateAll: vscode.QuickPickItem = {
    label: `$(warning) Evaluate all ${jobs.length} modules, including derived dependents`,
    detail: actionDetail(jobs),
    alwaysShow: true,
  };
  const labels = { changed: "Changed files", dependent: "Compile-time dependents", derived: "Derived dependents" };
  const picker = vscode.window.createQuickPick();
  picker.title = `Scry: evaluate modules in ${environmentName}`;
  picker.placeholder = "Search files to review; choose an Evaluate action to confirm. Escape cancels.";
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.items = [
    evaluateDirect,
    ...(directJobs.length < jobs.length ? [evaluateAll] : []),
    ...(["changed", "dependent", "derived"] as const).flatMap((reason) => {
      const items = jobs.flatMap((job) => job.reason === reason ? [{
        label: path.basename(job.relativePath),
        description: path.dirname(job.relativePath),
        detail: job.endpoint.service,
      }] : []);
      return items.length === 0 ? [] : [
        { label: `${labels[reason]} (${items.length})`, kind: vscode.QuickPickItemKind.Separator },
        ...items,
      ];
    }),
  ];

  // File rows are for review. Only the explicit Evaluate actions send code.
  const subscriptions: vscode.Disposable[] = [];
  let selected: typeof jobs | undefined;
  try {
    selected = await new Promise<typeof jobs | undefined>((resolve) => {
      subscriptions.push(
        picker.onDidAccept(() => {
          if (picker.selectedItems[0] === evaluateDirect) resolve(directJobs);
          if (picker.selectedItems[0] === evaluateAll) resolve(jobs);
        }),
        picker.onDidHide(() => resolve(undefined)),
      );
      picker.show();
    });
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    picker.dispose();
  }
  if (!selected) return;

  const sessionId = await workspaceSessionId(extensionContext, project);
  const failures: string[] = [];

  for (const job of selected) {
    const host = job.endpoint.hosts[0];
    if (!host) throw new Error(`No host configured for ${job.endpoint.service}`);

    try {
      const response = await sendEvalRequest(
        { host, port: job.endpoint.port, timeoutMs: job.endpoint.timeoutMs },
        evalRequest(job.endpoint, sessionId, job.code),
        job.endpoint.protocol,
      );
      if (response.status === "error") failures.push(`${job.relativePath}: ${response.error}`);
    } catch (error) {
      failures.push(`${job.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to evaluate ${failures.length}/${selected.length} modules:\n${failures.join("\n")}`);
  }

  const evaluatedModules = selected.map(({ relativePath }) => relativePath).join("\n");
  vscode.window.showInformationMessage(
    `Scry: evaluated ${selected.length} modules:\n${evaluatedModules}`,
  );
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
    output: options.output,
    environmentName,
    ...(pickedHost ? { host: pickedHost } : {}),
    everywhere: options.everywhere ?? options.repeated?.everywhere ?? false,
  };

  const responses = await Promise.all(
    hosts.map((host) =>
      timedEvalRequest(host, endpoint, evalRequest(endpoint, sessionId, source.code)),
    ),
  );

  await displayResponses(editor, options.output, responses);
}

// Sends one eval request and reports how long the round trip took, turning
// transport failures into error responses so every host still gets displayed.
async function timedEvalRequest(
  host: string,
  endpoint: ResolvedEndpoint,
  request: EvalRequest,
): Promise<{ host: string; durationMs: number; response: ScryResponse }> {
  const startedAt = Date.now();

  try {
    const response = await sendEvalRequest(
      { host, port: endpoint.port, timeoutMs: endpoint.timeoutMs },
      request,
      endpoint.protocol,
    );
    return { host, durationMs: Date.now() - startedAt, response };
  } catch (error) {
    return {
      host,
      durationMs: Date.now() - startedAt,
      response: {
        version: 1,
        requestId: null,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        output: "",
        diagnostics: [],
      },
    };
  }
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
  if (endpoint.protocol === "xrpc") {
    vscode.window.showInformationMessage("XRPC targets do not keep persistent Scry sessions");
    return;
  }
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
  const { config } = await loadProjectConfig(projectRoot);
  const relativeFilePath = path.relative(projectRoot, editor.document.uri.fsPath);

  return {
    config,
    application: findApplication(config, relativeFilePath),
    projectRoot,
    workspaceKey: vscode.Uri.file(projectRoot).toString(),
  };
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

function selectedCode(editor: vscode.TextEditor): { code: string } {
  const code = editor.selection.isEmpty
    ? editor.document.getText().trim()
    : editor.document.getText(editor.selection).trim();
  if (code === "") throw new Error("No Elixir code to evaluate");

  return { code };
}

async function displayResponses(
  editor: vscode.TextEditor,
  output: "inline" | "panel",
  responses: Array<{ host: string; durationMs: number; response: ScryResponse }>,
): Promise<void> {
  const failures = responses.filter(
    (item): item is { host: string; durationMs: number; response: Extract<ScryResponse, { status: "error" }> } =>
      item.response.status === "error",
  );
  if (failures.length > 0) {
    throw new Error(
      failures
        .map(({ host, durationMs, response }) => `${host}: ${responseText(response, durationMs)}`)
        .join("\n\n"),
    );
  }

  const moduleResponses = responses.filter(
    ({ response }) => response.status === "ok" && response.kind === "module",
  );
  if (moduleResponses.length === responses.length) {
    vscode.window.showInformationMessage(
      moduleResponses
        .map(({ durationMs, response }) => `${responseText(response)} (${formatDuration(durationMs)})`)
        .join("; "),
    );
    return;
  }

  const text = responses
    .map(({ host, durationMs, response }) =>
      `${responses.length > 1 ? `[${host}]\n` : ""}${responseText(response, durationMs)}`)
    .join("\n\n");

  if (output === "panel") {
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
      `${leadingNewline}${indentation}(\n${body}\n${indentation})\n`,
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

export function deactivate(): void { }
