import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const COMMON_BIN_DIRS = [
  path.join(os.homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/homebrew/sbin",
  "/usr/local/sbin",
];

export function defaultSpawnEnv() {
  const pathEntries = new Set((process.env.PATH ?? "").split(path.delimiter).filter(Boolean));
  for (const dir of COMMON_BIN_DIRS) {
    pathEntries.add(dir);
  }

  return {
    ...process.env,
    PATH: Array.from(pathEntries).join(path.delimiter),
  };
}

export function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function stringifyCompact(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function readCommandOutput(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function resolveExecutable(binaryNames: string[], env: NodeJS.ProcessEnv): string {
  const pathValue = env.PATH ?? "";
  const directories = pathValue.split(path.delimiter).filter(Boolean);

  for (const binaryName of binaryNames) {
    if (binaryName.includes(path.sep) && existsSync(binaryName)) {
      return binaryName;
    }

    for (const directory of directories) {
      const candidate = path.join(directory, binaryName);
      if (existsSync(candidate)) {
        return candidate;
      }
      if (process.platform === "win32") {
        const windowsCandidate = `${candidate}.cmd`;
        if (existsSync(windowsCandidate)) {
          return windowsCandidate;
        }
      }
    }
  }

  return binaryNames[0]!;
}

export async function waitForReplayIdle(
  getLastActivityAt: () => number,
  options: { idleMs?: number; timeoutMs?: number } = {},
) {
  const idleMs = options.idleMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 2000;
  const startedAt = Date.now();

  for (;;) {
    const now = Date.now();
    if (now - getLastActivityAt() >= idleMs) {
      return;
    }

    if (now - startedAt >= timeoutMs) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
