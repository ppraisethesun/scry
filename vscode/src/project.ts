import { access } from "node:fs/promises";
import path from "node:path";

export async function findElixirProjectRoot(activeFilePath: string): Promise<string> {
  let directory = path.dirname(activeFilePath);

  while (true) {
    try {
      await access(path.join(directory, "mix.exs"));
      return directory;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`No mix.exs found above active file ${JSON.stringify(activeFilePath)}`);
    }

    directory = parent;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
