import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findElixirProjectRoot } from "../src/project.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Elixir project discovery", () => {
  it("finds the nearest mix project above the active file", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "scry-project-"));
    temporaryDirectories.push(workspaceRoot);

    const projectRoot = path.join(workspaceRoot, "backend");
    const sourceFile = path.join(projectRoot, "lib", "gl", "accounts.ex");
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(path.join(projectRoot, "mix.exs"), "");
    await writeFile(sourceFile, "");

    await expect(findElixirProjectRoot(sourceFile)).resolves.toBe(projectRoot);
  });
});
