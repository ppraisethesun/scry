import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findChangedModules } from "../src/changed-modules.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("changed module discovery", () => {
  it("includes staged, unstaged, and untracked .ex files only", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "scry-changed-"));
    temporaryDirectories.push(projectRoot);
    await git(projectRoot, ["init"]);

    await write(projectRoot, "lib/changed.ex", "defmodule Changed do\nend\n");
    await write(projectRoot, "lib/deleted.ex", "defmodule Deleted do\nend\n");
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["-c", "user.name=Scry", "-c", "user.email=scry@example.com", "commit", "-m", "initial"]);

    await write(projectRoot, "lib/changed.ex", "defmodule Changed do\n  def changed?, do: true\nend\n");
    await write(projectRoot, "lib/staged.ex", "defmodule Staged do\nend\n");
    await git(projectRoot, ["add", "lib/staged.ex"]);
    await write(projectRoot, "lib/untracked module.ex", "defmodule Untracked do\nend\n");
    await write(projectRoot, "test/not_a_module.exs", "ExUnit.start()\n");
    await rm(path.join(projectRoot, "lib/deleted.ex"));

    const modules = await findChangedModules(projectRoot);

    expect(modules.map(({ relativePath }) => relativePath)).toEqual([
      "lib/changed.ex",
      "lib/staged.ex",
      "lib/untracked module.ex",
    ]);
  });
});

async function write(projectRoot: string, relativePath: string, contents: string): Promise<void> {
  const filename = path.join(projectRoot, relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
