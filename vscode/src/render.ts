import type { ScryResponse } from "./protocol.js";

export function responseText(response: ScryResponse): string {
  const diagnostics = response.diagnostics.map(
    (item) => `[${item.severity.toUpperCase()}] ${item.file}:${item.line}:${item.column}: ${item.message}`,
  );

  const sections = [
    response.status === "ok" ? response.result : response.error,
    diagnostics.join("\n"),
    response.output === "" ? "" : `[OUTPUT]\n${response.output.trimEnd()}`,
  ];

  return sections.filter((section) => section !== "").join("\n\n");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
