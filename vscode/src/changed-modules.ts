import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export interface ChangedModule {
  absolutePath: string;
  relativePath: string;
  reason: ChangeReason;
}

// changed: edited in Git. dependent: reached from a changed file through
// compile/export edges only. derived: a compile-time caller of something that
// reaches a changed file at runtime; Mix would recompile it, but xref is
// file-granular, so these are usually false positives and are opt-in.
export type ChangeReason = "changed" | "dependent" | "derived";

export async function findChangedModules(projectRoot: string): Promise<ChangedModule[]> {
  const [tracked, untracked] = await Promise.all([
    git(projectRoot, ["diff", "--name-only", "--relative", "--diff-filter=ACMR", "-z", "HEAD", "--", "*.ex"]),
    git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", "*.ex"]),
  ]);

  const changed = [...new Set([...paths(tracked), ...paths(untracked)])]
    .filter((relativePath) => relativePath.endsWith(".ex") && !isTestPath(relativePath))
    .sort();
  if (changed.length === 0) return [];

  const [graphOutput, sourceFiles] = await Promise.all([
    execute(projectRoot, "mise", ["exec", "--", "mix", "xref", "graph", "--no-compile", "--no-deps-check", "--no-archives-check", "--format", "dot", "--output", "-"]),
    git(projectRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.ex"]),
  ]);
  const graph = parseDependencyGraph(graphOutput);
  if (graph.size === 0) {
    throw new Error("No Mix dependency graph found. Compile the project locally before evaluating changed modules.");
  }

  // Umbrella manifests use child-relative paths. Resolve those against the
  // source files, refusing ambiguous names rather than evaluating the wrong app.
  const files = [...new Set(paths(sourceFiles))];
  const resolvedGraph: DependencyGraph = new Map();
  const resolve = (filename: string): string => {
    if (files.includes(filename)) return filename;
    const matches = files.filter((file) => file.endsWith(`/${filename}`));
    if (matches.length > 1) throw new Error(`Ambiguous Mix dependency path ${filename}: ${matches.join(", ")}`);
    return matches[0] ?? filename;
  };
  for (const [file, dependencies] of graph) {
    resolvedGraph.set(resolve(file), dependencies.map((dependency) => ({ ...dependency, file: resolve(dependency.file) })));
  }

  const candidates = affectedFiles(changed, resolvedGraph)
    .filter(({ file }) => files.includes(file) && file.endsWith(".ex") && !isTestPath(file));
  const existing = await Promise.all(candidates.map(async ({ file }) => {
    try {
      await access(path.join(projectRoot, file));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }));
  return candidates.filter((_, index) => existing[index])
    .map(({ file, reason }) => ({ relativePath: file, absolutePath: path.join(projectRoot, file), reason }));
}

type DependencyKind = "compile" | "export" | "runtime";
type DependencyGraph = Map<string, { file: string; kind: DependencyKind }[]>;

// DOT is available on older Elixir versions too. Xref emits one node or edge
// per line, with compile/export labels and unlabeled runtime edges.
function parseDependencyGraph(output: string): DependencyGraph {
  const graph: DependencyGraph = new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*"([^"]+)"(?: -> "([^"]+)"(?: \[label="\((compile|export)\)"\])?)?\s*$/.exec(line);
    if (!match?.[1]) continue;
    const [, source, target, label] = match;
    const dependencies = graph.get(source) ?? [];
    if (target) dependencies.push({ file: target, kind: label === "compile" || label === "export" ? label : "runtime" });
    graph.set(source, dependencies);
  }
  return graph;
}

// Mirrors Mix recompilation: compile callers of any stale file (one reaching a
// changed file through any edges, e.g. A ->compile B ->runtime changed C) and
// export callers of any recompiled file need reevaluation. Files reached
// without a runtime hop are "dependent"; the rest are "derived".
function affectedFiles(changed: string[], graph: DependencyGraph): { file: string; reason: ChangeReason }[] {
  const callers = new Map<string, { file: string; kind: DependencyKind }[]>();
  for (const [file, dependencies] of graph) {
    for (const dependency of dependencies) {
      const entries = callers.get(dependency.file) ?? [];
      entries.push({ file, kind: dependency.kind });
      callers.set(dependency.file, entries);
    }
  }
  const closure = (kinds: DependencyKind[], start: Iterable<string>): Set<string> => {
    const reached = new Set(start);
    for (const file of reached) {
      for (const caller of callers.get(file) ?? []) {
        if (kinds.includes(caller.kind)) reached.add(caller.file);
      }
    }
    return reached;
  };
  const dependent = closure(["compile", "export"], changed);
  const stale = closure(["compile", "export", "runtime"], changed);
  const staleCompileCallers = [...stale].flatMap((file) =>
    (callers.get(file) ?? []).filter((caller) => caller.kind === "compile").map((caller) => caller.file));
  const affected = closure(["compile", "export"], [...changed, ...staleCompileCallers]);

  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordering = new Map([...affected].map((file) => [file, new Set(
    (graph.get(file) ?? [])
      .filter((dependency) => dependency.kind === "compile" && affected.has(dependency.file))
      .map((dependency) => dependency.file),
  )]));
  // Indirect runtime paths and export references are ordering preferences.
  // Xref tracks whole files, so these paths may describe code that never runs
  // during compilation. They must not override direct compile dependencies.
  function evaluationDependencies(file: string): Set<string> {
    const dependencies = new Set<string>();
    const seen = new Set([file]);
    const pending = (graph.get(file) ?? []).filter((dependency) => dependency.kind !== "runtime")
      .map((dependency) => dependency.file);
    for (const target of pending) {
      if (seen.has(target)) continue;
      seen.add(target);
      if (target !== file && affected.has(target)) dependencies.add(target);
      for (const dependency of graph.get(target) ?? []) pending.push(dependency.file);
    }
    return dependencies;
  }
  function reaches(file: string, target: string, seen = new Set<string>()): boolean {
    if (file === target) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    return [...ordering.get(file) ?? []].some((dependency) => reaches(dependency, target, seen));
  }
  function visit(file: string): void {
    if (visited.has(file)) return;
    if (visiting.has(file)) {
      throw new Error(`Direct compile-time dependency cycle involving ${file}; cannot safely order module evaluation.`);
    }
    visiting.add(file);
    for (const dependency of ordering.get(file) ?? []) visit(dependency);
    visiting.delete(file);
    visited.add(file);
    if (affected.has(file)) ordered.push(file);
  }
  // Validate mandatory edges first, then add only non-conflicting preferences.
  for (const file of [...affected].sort()) visit(file);
  for (const file of [...affected].sort()) {
    for (const dependency of evaluationDependencies(file)) {
      if (!reaches(dependency, file)) ordering.get(file)?.add(dependency);
    }
  }
  ordered.length = 0;
  visited.clear();
  for (const file of [...affected].sort()) visit(file);
  return ordered.map((file) => ({
    file,
    reason: changed.includes(file) ? "changed" : dependent.has(file) ? "dependent" : "derived",
  }));
}

// Test support modules are compiled by the test run, not the running app, so
// evaluating them into a live node is never what the user wants.
function isTestPath(relativePath: string): boolean {
  return relativePath.split(path.sep).includes("test");
}

function paths(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

function git(cwd: string, args: string[]): Promise<string> {
  return execute(cwd, "git", args);
}

function execute(cwd: string, command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}
