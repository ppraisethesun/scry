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
  it("includes staged, unstaged, and untracked .ex files outside test directories", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "scry-changed-"));
    temporaryDirectories.push(projectRoot);
    await git(projectRoot, ["init"]);
    await writeMixProject(projectRoot);

    await write(projectRoot, "lib/changed.ex", "defmodule Changed do\nend\n");
    await write(projectRoot, "lib/deleted.ex", "defmodule Deleted do\nend\n");
    await compile(projectRoot);
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["-c", "user.name=Scry", "-c", "user.email=scry@example.com", "commit", "-m", "initial"]);

    await write(projectRoot, "lib/changed.ex", "defmodule Changed do\n  def changed?, do: true\nend\n");
    await write(projectRoot, "lib/staged.ex", "defmodule Staged do\nend\n");
    await git(projectRoot, ["add", "lib/staged.ex"]);
    await write(projectRoot, "lib/untracked module.ex", "defmodule Untracked do\nend\n");
    await write(projectRoot, "test/not_a_module.exs", "ExUnit.start()\n");
    await write(projectRoot, "test/support/helper.ex", "defmodule Helper do\nend\n");
    await write(projectRoot, "apps/core/test/support/case.ex", "defmodule Case do\nend\n");
    await rm(path.join(projectRoot, "lib/deleted.ex"));

    const modules = await findChangedModules(projectRoot);

    expect(modules.map(({ relativePath }) => relativePath)).toEqual([
      "lib/changed.ex",
      "lib/staged.ex",
      "lib/untracked module.ex",
    ]);
  });

  it("includes transitive compile and export dependents in dependency order, excluding runtime callers", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "scry-dependents-"));
    temporaryDirectories.push(projectRoot);
    await git(projectRoot, ["init"]);
    await writeMixProject(projectRoot);
    await write(projectRoot, "lib/z_macro.ex", "defmodule ExampleMacro do\n  defmacro value, do: 1\nend\n");
    await write(projectRoot, "lib/b_consumer.ex", "defmodule Consumer do\n  require ExampleMacro\n  def value, do: ExampleMacro.value()\n  defstruct [:value]\nend\n");
    await write(projectRoot, "lib/a_transitive.ex", "defmodule Transitive do\n  @value Consumer.value()\n  def value, do: @value\nend\n");
    await write(projectRoot, "lib/struct_user.ex", "defmodule StructUser do\n  def value, do: %Consumer{}\nend\n");
    await write(projectRoot, "lib/runtime.ex", "defmodule Runtime do\n  def value, do: Consumer.value()\nend\n");
    await compile(projectRoot);
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["-c", "user.name=Scry", "-c", "user.email=scry@example.com", "commit", "-m", "initial"]);
    await write(projectRoot, "lib/z_macro.ex", "defmodule ExampleMacro do\n  defmacro value, do: 2\nend\n");

    const modules = await findChangedModules(projectRoot);
    expect(modules.map(({ relativePath }) => relativePath)).toEqual([
      "lib/z_macro.ex", "lib/b_consumer.ex", "lib/a_transitive.ex", "lib/struct_user.ex",
    ]);
    expect(modules.map(({ reason }) => reason)).toEqual(["changed", "dependent", "dependent", "dependent"]);
  });

  it("marks compile-time callers reached through runtime dependencies as derived, ignoring export callers of unrecompiled files", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "scry-runtime-"));
    temporaryDirectories.push(projectRoot);
    await git(projectRoot, ["init"]);
    await writeMixProject(projectRoot);
    await write(projectRoot, "lib/z_value.ex", "defmodule Value do\n  def value, do: 1\n  def cycle, do: Bridge.value()\nend\n");
    await write(projectRoot, "lib/bridge.ex", "defmodule Bridge do\n  defstruct [:value]\n  def value, do: Value.value()\nend\n");
    await write(projectRoot, "lib/a_capture.ex", "defmodule Capture do\n  @value Bridge.value()\n  def value, do: @value\nend\n");
    await write(projectRoot, "lib/struct_user.ex", "defmodule StructUser do\n  def value, do: %Bridge{}\nend\n");
    await compile(projectRoot);
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["-c", "user.name=Scry", "-c", "user.email=scry@example.com", "commit", "-m", "initial"]);
    await write(projectRoot, "lib/z_value.ex", "defmodule Value do\n  def value, do: 2\n  def cycle, do: Bridge.value()\nend\n");

    const modules = await findChangedModules(projectRoot);
    expect(modules.map(({ relativePath, reason }) => [relativePath, reason])).toEqual([
      ["lib/z_value.ex", "changed"], ["lib/a_capture.ex", "derived"],
    ]);
  });

  it("reports a missing local compilation instead of silently omitting dependents", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "scry-uncompiled-"));
    temporaryDirectories.push(projectRoot);
    await git(projectRoot, ["init"]);
    await writeMixProject(projectRoot);
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["-c", "user.name=Scry", "-c", "user.email=scry@example.com", "commit", "-m", "initial"]);
    await write(projectRoot, "lib/new.ex", "defmodule New do\nend\n");

    await expect(findChangedModules(projectRoot)).rejects.toThrow("Compile the project locally");
  });

  it("orders direct compile dependencies despite a runtime path back to the caller", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "scry-registry-"));
    temporaryDirectories.push(projectRoot);
    await git(projectRoot, ["init"]);
    await writeMixProject(projectRoot);
    await write(projectRoot, "lib/z_macro.ex", "defmodule RegistryMacro do\n  defmacro value, do: 1\n  def registry, do: ActionRegistry.value()\n  def handler, do: Handler.run()\nend\n");
    await write(projectRoot, "lib/action_registry.ex", "defmodule ActionRegistry do\n  require RegistryMacro\n  def value, do: RegistryMacro.value()\n  def run, do: Handler.run()\nend\n");
    await write(projectRoot, "lib/handler.ex", "defmodule Handler do\n  @value ActionRegistry.value()\n  def run, do: @value\nend\n");
    await compile(projectRoot);
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["-c", "user.name=Scry", "-c", "user.email=scry@example.com", "commit", "-m", "initial"]);
    await write(projectRoot, "lib/z_macro.ex", "defmodule RegistryMacro do\n  defmacro value, do: 2\n  def registry, do: ActionRegistry.value()\n  def handler, do: Handler.run()\nend\n");

    const modules = await findChangedModules(projectRoot);
    expect(modules.map(({ relativePath }) => relativePath)).toEqual([
      "lib/z_macro.ex", "lib/action_registry.ex", "lib/handler.ex",
    ]);
  });
});

async function writeMixProject(projectRoot: string): Promise<void> {
  await write(projectRoot, ".gitignore", "_build/\n");
  await write(projectRoot, "mix.exs", "defmodule Fixture.MixProject do\n  use Mix.Project\n  def project, do: [app: :fixture, version: \"0.1.0\"]\nend\n");
}

function compile(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("mise", ["exec", "--", "mix", "compile"], { cwd }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

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
