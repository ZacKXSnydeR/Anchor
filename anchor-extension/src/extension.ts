import { ChildProcess } from "child_process";
import * as fs from "fs";
import * as vscode from "vscode";

import { ensureAgentSkillSystem } from "./agents/bootstrap";
import {
  daemonBinaryExists,
  ensureAutostartRegistered,
  resolveDaemonPath,
  startDaemonProcess,
} from "./cdp/bridge";
import { AnchorMessage, DaemonClient } from "./ipc/daemon-client";
import { AutoCommitManager } from "./git/autocommit";
import { McpRegistrar } from "./mcp/registrar";
import { RecoveryDashboard } from "./recovery/restore-ui";
import { StateRepair } from "./recovery/state-repair";
import { StatusBarManager } from "./ui/statusbar";
import { ConversationWatcher } from "./watchers/conversation";
import { FileStateWatcher } from "./watchers/filestate";

let daemonProcess: ChildProcess | undefined;
let extensionInstallPath = "";
let extensionDaemonClient: DaemonClient | undefined;
let conversationWatcher: ConversationWatcher | undefined;
let fileStateWatcher: FileStateWatcher | undefined;
let autoCommitManager: AutoCommitManager | undefined;
let recoveryDashboard: RecoveryDashboard | undefined;
let extensionMcpRegistrar: McpRegistrar | undefined;
let stateRepair: StateRepair | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionInstallPath = context.extensionPath;

  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  statusBar.setStatus("connecting");

  try {
    await ensureAutostartRegistered(getDaemonPath());
  } catch (error) {
    vscode.window.showWarningMessage(
      `Anchor could not configure auto-start: ${formatError(error)}`,
    );
  }

  const daemonClient = new DaemonClient();
  extensionDaemonClient = daemonClient;

  const connected = await daemonClient.connect().then(
    () => true,
    () => false,
  );

  if (!connected) {
    try {
      await startDaemon();
    } catch (error) {
      statusBar.setStatus("disconnected");
      vscode.window.showErrorMessage(`Anchor failed to launch daemon: ${formatError(error)}`);
      return;
    }

    try {
      await daemonClient.connect();
    } catch (error) {
      statusBar.setStatus("disconnected");
      vscode.window.showWarningMessage(
        `Anchor daemon is unreachable: ${formatError(error)}`,
      );
    }
  }

  context.subscriptions.push({
    dispose: () => {
      daemonClient.dispose();
    },
  });

  let mcpRegistrar: McpRegistrar | undefined;
  try {
    mcpRegistrar = new McpRegistrar(context, getDaemonPath());
    extensionMcpRegistrar = mcpRegistrar;
  } catch (error) {
    vscode.window.showWarningMessage(
      `Anchor MCP registration disabled: ${formatError(error)}`,
    );
  }

  registerCommands(context, daemonClient, statusBar, mcpRegistrar);

  recoveryDashboard = new RecoveryDashboard(context, daemonClient);
  context.subscriptions.push(recoveryDashboard);

  conversationWatcher = new ConversationWatcher(daemonClient);
  conversationWatcher.start();
  context.subscriptions.push(conversationWatcher);

  autoCommitManager = new AutoCommitManager();
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspacePath) {
    await autoCommitManager.initialize(workspacePath);
    autoCommitManager.scheduleAutoCommit();
  }
  context.subscriptions.push(autoCommitManager);

  fileStateWatcher = new FileStateWatcher(daemonClient, {
    getCurrentConversationId: () => conversationWatcher?.getCurrentConversationId() ?? null,
    onAiEditStart: async (description: string) => {
      if (autoCommitManager) {
        await autoCommitManager.commitBeforeAiEdit(description);
      }
    },
  });
  fileStateWatcher.start();
  context.subscriptions.push(fileStateWatcher);

  stateRepair = new StateRepair();
  const repairResult = await runStateRepairStartup(daemonClient, statusBar, stateRepair);
  if (repairResult.success && repairResult.restoredCount > 0) {
    vscode.window.showInformationMessage(
      `Anchor restored ${repairResult.restoredCount} missing sidebar conversation entries.`,
    );
  } else if (!repairResult.success) {
    vscode.window.showWarningMessage(
      "Anchor state database repair could not complete. Your previous DB backup was preserved.",
    );
  }

  if (workspacePath) {
    const bootstrapResult = await ensureAgentSkillSystem(workspacePath);
    if (bootstrapResult.changed) {
      vscode.window.showInformationMessage(
        "Anchor agent safety assets were installed (.agents skill/workflows + AGENTS.md update).",
      );
    }
  }

  let mcpHealthy = true;
  if (mcpRegistrar) {
    try {
      const registerResult = await mcpRegistrar.register();
      if (registerResult.needsRestart) {
        const action = await vscode.window.showInformationMessage(
          "Anchor registered WAL-protected MCP tools. Restart Antigravity to activate crash-safe editing.",
          "Restart Now",
          "Later",
        );
        if (action === "Restart Now") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      }

      const verifyResult = await mcpRegistrar.verify();
      mcpHealthy = verifyResult.working;
      if (!verifyResult.working && verifyResult.error) {
        vscode.window.showWarningMessage(`Anchor MCP verify failed: ${verifyResult.error}`);
      }
    } catch (error) {
      mcpHealthy = false;
      vscode.window.showWarningMessage(
        `Anchor MCP registration failed: ${formatError(error)}`,
      );
    }
  }

  if (daemonClient.isConnected()) {
    statusBar.setStatus("recovering");
    await runRecoveryCheck(daemonClient, statusBar);
    statusBar.setStatus(mcpHealthy ? "protected" : "mcp-error");
  } else {
    statusBar.setStatus("disconnected");
  }
}

export async function deactivate(): Promise<void> {
  if (fileStateWatcher) {
    await fileStateWatcher.deactivate();
    fileStateWatcher.dispose();
    fileStateWatcher = undefined;
  }

  if (conversationWatcher) {
    await conversationWatcher.deactivate();
    conversationWatcher.dispose();
    conversationWatcher = undefined;
  }

  if (autoCommitManager) {
    autoCommitManager.dispose();
    autoCommitManager = undefined;
  }

  if (recoveryDashboard) {
    recoveryDashboard.dispose();
    recoveryDashboard = undefined;
  }

  if (extensionDaemonClient) {
    extensionDaemonClient.dispose();
    extensionDaemonClient = undefined;
  }

  extensionMcpRegistrar = undefined;
  stateRepair = undefined;

  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill();
  }
}

function registerCommands(
  context: vscode.ExtensionContext,
  daemonClient: DaemonClient,
  statusBar: StatusBarManager,
  mcpRegistrar: McpRegistrar | undefined,
): void {
  const recoverCommand = vscode.commands.registerCommand("anchor.recover", async () => {
    statusBar.setStatus("recovering");
    if (await ensureConnected(daemonClient, statusBar)) {
      await recoveryDashboard?.show();
    }
    statusBar.setStatus(daemonClient.isConnected() ? "protected" : "disconnected");
  });

  const historyCommand = vscode.commands.registerCommand("anchor.showHistory", async () => {
    if (!(await ensureConnected(daemonClient, statusBar))) {
      return;
    }

    const response = await daemonClient.sendMessage({ type: "GetConversations" });
    if (response.type === "Data") {
      const entries = Array.isArray(response.payload) ? response.payload : [];
      vscode.window.showInformationMessage(`Anchor history entries: ${entries.length}`);
      return;
    }

    handleNonDataResponse(response);
  });

  const exportCommand = vscode.commands.registerCommand(
    "anchor.exportConversation",
    async () => {
      if (!(await ensureConnected(daemonClient, statusBar))) {
        return;
      }

      const conversationId = await vscode.window.showInputBox({
        prompt: "Conversation ID to export",
        placeHolder: "conversation UUID",
      });

      if (!conversationId) {
        return;
      }

      const response = await daemonClient.sendMessage({
        type: "Recover",
        payload: { conversation_id: conversationId },
      });

      if (response.type !== "Data") {
        handleNonDataResponse(response);
        return;
      }

      const uri = await vscode.window.showSaveDialog({
        saveLabel: "Export conversation",
        defaultUri: vscode.Uri.file(`conversation-${conversationId}.json`),
      });

      if (!uri) {
        return;
      }

      const content = Buffer.from(JSON.stringify(response.payload, null, 2), "utf8");
      await vscode.workspace.fs.writeFile(uri, content);
      vscode.window.showInformationMessage("Conversation exported by Anchor");
    },
  );

  const verifyMcpCommand = vscode.commands.registerCommand("anchor.verifyMcp", async () => {
    if (!mcpRegistrar) {
      vscode.window.showWarningMessage("Anchor MCP registrar is not available.");
      return;
    }

    const verifyResult = await mcpRegistrar.verify();
    if (verifyResult.working) {
      statusBar.setStatus("protected");
      vscode.window.showInformationMessage("Anchor MCP tools are working.");
      return;
    }

    statusBar.setStatus("mcp-error");
    vscode.window.showWarningMessage(
      `Anchor MCP verify failed: ${verifyResult.error ?? "Unknown MCP error"}`,
    );
  });

  const unregisterMcpCommand = vscode.commands.registerCommand(
    "anchor.unregisterMcp",
    async () => {
      if (!mcpRegistrar) {
        vscode.window.showWarningMessage("Anchor MCP registrar is not available.");
        return;
      }

      await mcpRegistrar.unregister();
      statusBar.setStatus("mcp-error");
      vscode.window.showInformationMessage(
        "Anchor MCP tools were unregistered. Restart Antigravity to fully apply.",
      );
    },
  );

  const runStateRepairCommand = vscode.commands.registerCommand(
    "anchor.runStateRepair",
    async () => {
      const repair = stateRepair ?? new StateRepair();
      const result = await runStateRepairStartup(daemonClient, statusBar, repair);

      if (result.success) {
        vscode.window.showInformationMessage(
          `Anchor state repair complete. Restored ${result.restoredCount}, total index entries ${result.totalConversations}.`,
        );
      } else {
        vscode.window.showWarningMessage(
          `Anchor state repair failed. Backup: ${result.backupPath || "not created"}`,
        );
      }

      statusBar.setStatus(daemonClient.isConnected() ? "protected" : "disconnected");
    },
  );

  context.subscriptions.push(
    recoverCommand,
    historyCommand,
    exportCommand,
    verifyMcpCommand,
    unregisterMcpCommand,
    runStateRepairCommand,
  );
}

async function ensureConnected(
  daemonClient: DaemonClient,
  statusBar: StatusBarManager,
): Promise<boolean> {
  if (daemonClient.isConnected()) {
    return true;
  }

  statusBar.setStatus("connecting");

  try {
    await daemonClient.connect();
    statusBar.setStatus("protected");
    return true;
  } catch (error) {
    statusBar.setStatus("disconnected");
    vscode.window.showErrorMessage(`Failed to connect Anchor daemon: ${formatError(error)}`);
    return false;
  }
}

async function runRecoveryCheck(
  daemonClient: DaemonClient,
  statusBar: StatusBarManager,
): Promise<void> {
  if (!(await ensureConnected(daemonClient, statusBar))) {
    return;
  }

  const response = await daemonClient.sendMessage({
    type: "Recover",
    payload: { conversation_id: "startup" },
  });

  if (response.type === "Data") {
    const recoveredCount =
      typeof response.payload === "object" && response.payload !== null
        ? Number((response.payload as Record<string, unknown>).recovered_count ?? 0)
        : 0;

    if (!Number.isNaN(recoveredCount) && recoveredCount > 0) {
      statusBar.showRecoveryNotification(recoveredCount);
    }
    return;
  }

  if (response.type === "Error") {
    vscode.window.showWarningMessage(`Anchor recovery check failed: ${response.payload}`);
  }
}

async function runStateRepairStartup(
  daemonClient: DaemonClient,
  statusBar: StatusBarManager,
  repair: StateRepair,
): Promise<{ success: boolean; restoredCount: number; totalConversations: number; backupPath: string }> {
  statusBar.setStatus("recovering");

  if (daemonClient.isConnected()) {
    try {
      await daemonClient.sendMessage({ type: "RunStateRepair" });
    } catch {
      // Daemon fallback is best-effort; extension-side repair continues.
    }
  }

  try {
    return await repair.runFullRepair();
  } catch {
    return {
      success: false,
      restoredCount: 0,
      totalConversations: 0,
      backupPath: "",
    };
  }
}

async function startDaemon(): Promise<void> {
  if (daemonProcess && !daemonProcess.killed) {
    return;
  }

  const daemonPath = getDaemonPath();

  daemonProcess = startDaemonProcess(daemonPath);

  daemonProcess.on("error", (error) => {
    vscode.window.showErrorMessage(`Failed to start Anchor daemon: ${formatError(error)}`);
  });
}

export function getDaemonPath(): string {
  if (!extensionInstallPath) {
    const message = "Anchor extension path is not initialized yet.";
    throw new Error(message);
  }

  const daemonPath = resolveDaemonPath(extensionInstallPath, process.platform, process.arch);

  if (!daemonBinaryExists(daemonPath) || !fs.statSync(daemonPath).isFile()) {
    const message = `Anchor daemon binary is missing for ${process.platform}/${process.arch}: ${daemonPath}`;
    void vscode.window.showErrorMessage(message);
    throw new Error(message);
  }

  return daemonPath;
}

function handleNonDataResponse(response: AnchorMessage): void {
  if (response.type === "Error") {
    vscode.window.showErrorMessage(`Anchor daemon error: ${response.payload}`);
    return;
  }

  vscode.window.showWarningMessage(`Unexpected daemon response: ${response.type}`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
