import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parseConfig, type ScryConfig } from "./config.js";

export async function findElixirProjectRoot(activeFilePath: string): Promise<string> {
  return findMixRoot(path.dirname(activeFilePath));
}

// Walks up from a directory to the nearest one containing mix.exs.
export async function findMixRoot(startDirectory: string): Promise<string> {
  let directory = startDirectory;

  while (true) {
    try {
      await access(path.join(directory, "mix.exs"));
      return directory;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`No mix.exs found above ${JSON.stringify(startDirectory)}`);
    }

    directory = parent;
  }
}

// Reads `.scry.local.json`, falling back to `.scry.json`, from a Mix project root. They are never merged.
export async function loadProjectConfig(projectRoot: string): Promise<{ path: string; config: ScryConfig }> {
  for (const filename of [".scry.local.json", ".scry.json"]) {
    const configPath = path.join(projectRoot, filename);
    try {
      return { path: configPath, config: parseConfig(await readFile(configPath, "utf8")) };
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
