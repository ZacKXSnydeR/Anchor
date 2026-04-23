import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type RegisterResult = {
  registered: boolean;
  needsRestart: boolean;
};

export type VerifyResult = {
  working: boolean;
  error?: string;
};

type McpServerConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

type McpRootConfig = {
  mcpServers: Record<string, unknown>;
  passthrough: Record<string, unknown>;
};

export class McpRegistrar {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly daemonBinaryPath: string,
  ) {}

  getMcpConfigPath(): string {
    return path.join(os.homedir(), ".gemini", "antigravity", "mcp_config.json");
  }

  async register(): Promise<RegisterResult> {
    if (!fs.existsSync(this.daemonBinaryPath)) {
      throw new Error(`Anchor daemon binary not found: ${this.daemonBinaryPath}`);
    }

    const configPath = this.getMcpConfigPath();
    const root = await this.readRootConfig(configPath);
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    const desired: McpServerConfig = {
      command: this.daemonBinaryPath,
      args: ["--mcp-mode"],
      env: {
        ANCHOR_WORKSPACE: workspacePath,
        ANCHOR_LOG: "error",
      },
    };

    const existing = root.mcpServers.anchor;
    const needsRestart = existing === undefined;
    const changed = !areConfigsEqual(existing, desired);
    if (!changed) {
      return { registered: true, needsRestart: false };
    }

    root.mcpServers.anchor = desired;
    await this.writeRootConfig(configPath, root);
    return { registered: true, needsRestart };
  }

  async unregister(): Promise<void> {
    const configPath = this.getMcpConfigPath();
    const root = await this.readRootConfig(configPath);
    if (root.mcpServers.anchor === undefined) {
      return;
    }

    delete root.mcpServers.anchor;
    await this.writeRootConfig(configPath, root);
  }

  async isRegistered(): Promise<boolean> {
    const configPath = this.getMcpConfigPath();
    const root = await this.readRootConfig(configPath);
    const anchorEntry = root.mcpServers.anchor;
    if (!isRecord(anchorEntry)) {
      return false;
    }

    const command = anchorEntry.command;
    if (typeof command !== "string" || command.length === 0) {
      return false;
    }

    return fs.existsSync(command);
  }

  async verify(): Promise<VerifyResult> {
    if (!fs.existsSync(this.daemonBinaryPath)) {
      return {
        working: false,
        error: `Anchor daemon binary not found: ${this.daemonBinaryPath}`,
      };
    }

    return new Promise<VerifyResult>((resolve) => {
      const child = spawn(this.daemonBinaryPath, ["--mcp-mode", "--test"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ANCHOR_LOG: "error",
        },
      });

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let settled = false;

      const settle = (result: VerifyResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill();
        settle({ working: false, error: "MCP verify timed out after 2 seconds" });
      }, 2000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        settle({ working: false, error: `Failed to spawn MCP test mode: ${error.message}` });
      });

      child.on("close", () => {
        clearTimeout(timer);
        const firstLine = stdoutBuffer
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0);

        if (!firstLine) {
          const stderrMessage = stderrBuffer.trim();
          settle({
            working: false,
            error:
              stderrMessage.length > 0
                ? `No MCP test response on stdout. stderr: ${stderrMessage}`
                : "No MCP test response on stdout",
          });
          return;
        }

        try {
          const parsed = JSON.parse(firstLine) as unknown;
          if (!isRecord(parsed)) {
            settle({ working: false, error: "MCP test response is not a JSON object" });
            return;
          }

          const resultField = parsed.result;
          if (isRecord(resultField) && typeof resultField.protocolVersion === "string") {
            settle({ working: true });
            return;
          }

          if (typeof parsed.protocolVersion === "string") {
            settle({ working: true });
            return;
          }

          settle({
            working: false,
            error: "MCP test response did not contain protocolVersion",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          settle({
            working: false,
            error: `Invalid JSON from MCP test response: ${message}`,
          });
        }
      });
    });
  }

  private async readRootConfig(configPath: string): Promise<McpRootConfig> {
    const configDir = path.dirname(configPath);
    await fs.promises.mkdir(configDir, { recursive: true });

    if (!fs.existsSync(configPath)) {
      return { mcpServers: {}, passthrough: {} };
    }

    const raw = await fs.promises.readFile(configPath, "utf8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        return { mcpServers: {}, passthrough: {} };
      }

      const mcpServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
      const passthrough: Record<string, unknown> = {};
      Object.entries(parsed).forEach(([key, value]) => {
        if (key !== "mcpServers") {
          passthrough[key] = value;
        }
      });

      return { mcpServers, passthrough };
    } catch {
      const backupPath = path.join(
        configDir,
        `mcp_config.backup-${Date.now()}-${this.context.extension.id}.json`,
      );
      await fs.promises.writeFile(backupPath, raw, "utf8");
      return { mcpServers: {}, passthrough: {} };
    }
  }

  private async writeRootConfig(configPath: string, root: McpRootConfig): Promise<void> {
    const finalObject: Record<string, unknown> = {
      ...root.passthrough,
      mcpServers: root.mcpServers,
    };
    const serialized = `${JSON.stringify(finalObject, null, 2)}\n`;
    await writeAtomically(configPath, serialized);
  }
}

function areConfigsEqual(existing: unknown, desired: McpServerConfig): boolean {
  if (!isRecord(existing)) {
    return false;
  }

  const command = existing.command;
  const args = existing.args;
  const env = existing.env;

  if (command !== desired.command) {
    return false;
  }

  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    return false;
  }

  const argsMatch = JSON.stringify(args) === JSON.stringify(desired.args);
  if (!argsMatch) {
    return false;
  }

  if (!isRecord(env)) {
    return false;
  }

  const currentEnv: Record<string, string> = {};
  Object.entries(env).forEach(([key, value]) => {
    if (typeof value === "string") {
      currentEnv[key] = value;
    }
  });

  return JSON.stringify(currentEnv) === JSON.stringify(desired.env);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeAtomically(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.anchor-mcp-${process.pid}-${Date.now()}.tmp`);

  await fs.promises.writeFile(tempPath, content, "utf8");

  try {
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EEXIST" || err.code === "EPERM") {
      await fs.promises.rm(targetPath, { force: true });
      await fs.promises.rename(tempPath, targetPath);
      return;
    }

    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}
