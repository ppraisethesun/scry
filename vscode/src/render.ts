import type { ScryResponse } from "./protocol.js";

// Formats an elapsed round-trip duration for display, e.g. `1.23s` or `840ms`.
export function formatDuration(durationMs: number): string {
  if (durationMs >= 1_000) return `${(durationMs / 1_000).toFixed(2)}s`;
  return `${Math.round(durationMs)}ms`;
}

// Renders a response for display, optionally prefixed with a `# <elapsed>` comment
// line so inline insertions stay valid Elixir.
export function responseText(response: ScryResponse, durationMs?: number): string {
  const diagnostics = response.diagnostics.map(
    (item) => `[${item.severity.toUpperCase()}] ${item.file}:${item.line}:${item.column}: ${item.message}`,
  );

  const sections = [
    response.status === "ok" ? response.result : response.error,
    diagnostics.join("\n"),
    response.output === "" ? "" : `[OUTPUT]\n${response.output.trimEnd()}`,
  ];

  const body = sections.filter((section) => section !== "").join("\n\n");

  return durationMs === undefined ? body : `# ${formatDuration(durationMs)}\n${body}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
