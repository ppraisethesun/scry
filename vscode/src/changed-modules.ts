import { execFile } from "node:child_process";
import path from "node:path";

export interface ChangedModule {
  absolutePath: string;
  relativePath: string;
}

export async function findChangedModules(projectRoot: string): Promise<ChangedModule[]> {
  const [tracked, untracked] = await Promise.all([
    git(projectRoot, ["diff", "--name-only", "--relative", "--diff-filter=ACMR", "-z", "HEAD", "--", "*.ex"]),
    git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", "*.ex"]),
  ]);

  return [...new Set([...paths(tracked), ...paths(untracked)])]
    .filter((relativePath) => relativePath.endsWith(".ex"))
    .sort()
    .map((relativePath) => ({ relativePath, absolutePath: path.join(projectRoot, relativePath) }));
}

function paths(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
