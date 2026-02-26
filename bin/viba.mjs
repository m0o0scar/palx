#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/lib/cli-args.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const DEFAULT_PORT = 3200;
const AGENT_BROWSER_SKILL_NAME = "agent-browser";
const AGENT_BROWSER_SKILL_SOURCE_URL = "https://skills.sh/vercel-labs/agent-browser/agent-browser";
const AGENT_BROWSER_SKILL_REPO_URL = "https://github.com/vercel-labs/agent-browser";
const AGENT_BROWSER_TARGET_AGENTS = ["codex", "cursor", "gemini-cli"];

function getNextBin() {
  return require.resolve("next/dist/bin/next");
}

function isCommandAvailable(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], {
    stdio: "ignore",
    env: process.env,
  });
  return result.status === 0;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: APP_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  return result.status === 0;
}

export function getInstallStrategies(packageName) {
  if (process.platform === "darwin") {
    return [
      {
        label: "Homebrew",
        requiredCommands: ["brew"],
        command: "brew",
        args: ["install", packageName],
      },
      {
        label: "MacPorts",
        requiredCommands: ["sudo", "port"],
        command: "sudo",
        args: ["port", "install", packageName],
      },
    ];
  }

  if (process.platform === "linux") {
    return [
      {
        label: "apt-get",
        requiredCommands: ["apt-get"],
        command: "apt-get",
        args: ["install", "-y", packageName],
      },
      {
        label: "sudo apt-get",
        requiredCommands: ["sudo", "apt-get"],
        command: "sudo",
        args: ["apt-get", "install", "-y", packageName],
      },
      {
        label: "dnf",
        requiredCommands: ["dnf"],
        command: "dnf",
        args: ["install", "-y", packageName],
      },
      {
        label: "sudo dnf",
        requiredCommands: ["sudo", "dnf"],
        command: "sudo",
        args: ["dnf", "install", "-y", packageName],
      },
      {
        label: "yum",
        requiredCommands: ["yum"],
        command: "yum",
        args: ["install", "-y", packageName],
      },
      {
        label: "sudo yum",
        requiredCommands: ["sudo", "yum"],
        command: "sudo",
        args: ["yum", "install", "-y", packageName],
      },
      {
        label: "pacman",
        requiredCommands: ["pacman"],
        command: "pacman",
        args: ["-S", "--noconfirm", packageName],
      },
      {
        label: "sudo pacman",
        requiredCommands: ["sudo", "pacman"],
        command: "sudo",
        args: ["pacman", "-S", "--noconfirm", packageName],
      },
      {
        label: "zypper",
        requiredCommands: ["zypper"],
        command: "zypper",
        args: ["--non-interactive", "install", packageName],
      },
      {
        label: "sudo zypper",
        requiredCommands: ["sudo", "zypper"],
        command: "sudo",
        args: ["zypper", "--non-interactive", "install", packageName],
      },
    ];
  }

  if (process.platform === "win32") {
    if (packageName !== "ttyd") {
      return [];
    }

    return [
      {
        label: "winget",
        requiredCommands: ["winget"],
        command: "winget",
        args: ["install", "tsl0922.ttyd"],
      },
      {
        label: "scoop",
        requiredCommands: ["scoop"],
        command: "scoop",
        args: ["install", "ttyd"],
      },
    ];
  }

  return [];
}

function ensureCommandInstalled(commandName) {
  if (isCommandAvailable(commandName)) {
    return;
  }

  console.log(`${commandName} is not installed. Attempting automatic installation...`);

  const installStrategies = getInstallStrategies(commandName);
  const availableManagers = installStrategies
    .map((strategy) => strategy.label)
    .join(", ");

  let attempted = false;

  for (const strategy of installStrategies) {
    const canUseStrategy = strategy.requiredCommands.every((command) => isCommandAvailable(command));
    if (!canUseStrategy) {
      continue;
    }

    attempted = true;
    console.log(`Trying to install ${commandName} via ${strategy.label}...`);

    if (runCommand(strategy.command, strategy.args) && isCommandAvailable(commandName)) {
      console.log(`${commandName} installed successfully.`);
      return;
    }
  }

  if (!attempted) {
    throw new Error(
      `${commandName} is required, but no supported package manager was found on this machine. Checked: ${availableManagers || "none"}. Install ${commandName} manually and restart.`,
    );
  }

  throw new Error(`${commandName} is required, but automatic installation failed. Install ${commandName} manually and restart.`);
}

function getCodexSkillsDirectory() {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "skills");
}

function getGlobalAgentsSkillsDirectory() {
  return path.join(os.homedir(), ".agents", "skills");
}

function ensureAgentBrowserSkillInstalled() {
  const targetSkillManifests = [
    path.join(getGlobalAgentsSkillsDirectory(), AGENT_BROWSER_SKILL_NAME, "SKILL.md"),
    path.join(getCodexSkillsDirectory(), AGENT_BROWSER_SKILL_NAME, "SKILL.md"),
  ];

  if (targetSkillManifests.some((manifestPath) => fs.existsSync(manifestPath))) {
    return;
  }

  if (!isCommandAvailable("npx")) {
    console.warn("Skipping Codex agent-browser skill installation: npx is not available.");
    return;
  }

  console.log(`Ensuring Codex skill '${AGENT_BROWSER_SKILL_NAME}' is installed from ${AGENT_BROWSER_SKILL_SOURCE_URL}...`);
  const addResult = spawnSync(
    "npx",
    [
      "skills",
      "add",
      AGENT_BROWSER_SKILL_REPO_URL,
      "--skill",
      AGENT_BROWSER_SKILL_NAME,
      "--agent",
      ...AGENT_BROWSER_TARGET_AGENTS,
      "-g",
      "-y",
    ],
    { cwd: APP_ROOT, env: process.env, stdio: "pipe" },
  );
  if (addResult.status !== 0) {
    const detail = addResult.stderr?.toString().trim() || addResult.stdout?.toString().trim() || "unknown error";
    console.warn(`Failed to install Codex agent-browser skill via npx skills add: ${detail}`);
  }
}

function printHelp() {
  console.log(`Usage: viba-cli [options]

Options:
  -p, --port <port>  Port to run on (default: 3200)
  --dev              Run in development mode
  -h, --help         Show this help message
`);
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(startPort, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = startPort + i;
    const available = await checkPortAvailable(candidate);
    if (available) {
      return candidate;
    }
  }
  throw new Error(`Could not find an available port in range ${startPort}-${startPort + maxAttempts - 1}.`);
}

function runNext(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [getNextBin(), ...args], {
      cwd: APP_ROOT,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code === null ? 1 : code);
    });
  });
}

function ensureBuildExists() {
  const buildIdPath = path.join(APP_ROOT, ".next", "BUILD_ID");
  if (!fs.existsSync(buildIdPath)) {
    throw new Error(
      "No production build found in this package (.next/BUILD_ID is missing). The npm package must be published with prebuilt assets.",
    );
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }

    ensureCommandInstalled("ttyd");
    if (process.platform !== "win32") {
      ensureCommandInstalled("tmux");
    }
    ensureAgentBrowserSkillInstalled();

    const envPort = Number.parseInt(process.env.PORT || "", 10);
    const preferredPort =
      options.port ??
      (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : DEFAULT_PORT);

    let port = preferredPort;
    if (!options.portExplicit && !process.env.PORT) {
      port = await findAvailablePort(preferredPort);
      if (port !== preferredPort) {
        console.log(`Port ${preferredPort} is in use. Using ${port} instead.`);
      }
    }

    if (options.mode === "dev") {
      console.log(`Starting viba in development mode on http://localhost:${port}`);
      process.exit(await runNext(["dev", "--webpack", "-p", String(port)]));
    }

    ensureBuildExists();
    console.log(`Starting viba on http://localhost:${port}`);
    process.exit(await runNext(["start", "-p", String(port)]));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`viba failed to start: ${errorMessage}`);
    process.exit(1);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    const invokedPath = fs.realpathSync(path.resolve(process.argv[1]));
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    return invokedPath === modulePath;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void main();
}
