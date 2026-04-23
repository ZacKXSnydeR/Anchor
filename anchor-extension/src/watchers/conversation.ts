import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import Database from "better-sqlite3";

import { DaemonClient } from "../ipc/daemon-client";

type ItemRow = {
  value: string;
};

export class ConversationWatcher implements vscode.Disposable {
  private readonly antigravityDir: string;
  private readonly conversationsPattern = "**/.antigravity/conversations/*.pb";
  private readonly contextStatePattern = "**/.antigravity/context_state/**";
  private readonly pendingSaves = new Set<Promise<void>>();

  private conversationWatcher: vscode.FileSystemWatcher | undefined;
  private contextWatcher: vscode.FileSystemWatcher | undefined;
  private currentConversationId: string | null = null;

  constructor(private readonly daemonClient: DaemonClient) {
    this.antigravityDir = path.join(os.homedir(), ".antigravity");
  }

  start(): void {
    if (!this.conversationWatcher) {
      const conversationGlob = new vscode.RelativePattern(
        os.homedir(),
        this.conversationsPattern,
      );
      this.conversationWatcher = vscode.workspace.createFileSystemWatcher(
        conversationGlob,
      );

      this.conversationWatcher.onDidCreate((uri) => {
        this.trackPending(this.handlePbFileChange(uri));
      });
      this.conversationWatcher.onDidChange((uri) => {
        this.trackPending(this.handlePbFileChange(uri));
      });
      this.conversationWatcher.onDidDelete((uri) => {
        this.trackPending(this.handlePbFileChange(uri));
      });
    }

    if (!this.contextWatcher) {
      const contextGlob = new vscode.RelativePattern(
        os.homedir(),
        this.contextStatePattern,
      );
      this.contextWatcher = vscode.workspace.createFileSystemWatcher(
        contextGlob,
      );

      this.contextWatcher.onDidCreate(() => {
        this.refreshCurrentConversationId();
      });
      this.contextWatcher.onDidChange(() => {
        this.refreshCurrentConversationId();
      });
      this.contextWatcher.onDidDelete(() => {
        this.refreshCurrentConversationId();
      });
    }

    this.refreshCurrentConversationId();
  }

  getCurrentConversationId(): string | null {
    return this.currentConversationId;
  }

  async deactivate(): Promise<void> {
    await this.flushPendingSaves();
    await this.sendFinalCheckpoint();
  }

  dispose(): void {
    this.conversationWatcher?.dispose();
    this.contextWatcher?.dispose();
    this.conversationWatcher = undefined;
    this.contextWatcher = undefined;
  }

  private trackPending(task: Promise<void>): void {
    this.pendingSaves.add(task);
    task.finally(() => {
      this.pendingSaves.delete(task);
    });
  }

  private async handlePbFileChange(uri: vscode.Uri): Promise<void> {
    const conversationId = path.basename(uri.fsPath, ".pb");
    if (!conversationId) {
      return;
    }

    const timestamp = Date.now();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    const metadata = await this.readMetadata(uri, timestamp);
    await this.ensureConnected();

    await this.daemonClient.sendMessage({
      type: "SaveConversation",
      payload: {
        conversation_id: conversationId,
        data: {
          id: conversationId,
          pb_path: metadata.path,
          size: metadata.size,
          modified_time: metadata.modifiedTime,
          timestamp,
          workspace,
        },
      },
    });
  }

  private async readMetadata(
    uri: vscode.Uri,
    fallbackTimestamp: number,
  ): Promise<{ path: string; size: number; modifiedTime: number }> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return {
        path: uri.fsPath,
        size: stat.size,
        modifiedTime: stat.mtime,
      };
    } catch {
      return {
        path: uri.fsPath,
        size: 0,
        modifiedTime: fallbackTimestamp,
      };
    }
  }

  private refreshCurrentConversationId(): void {
    const stateDbPath = path.join(this.antigravityDir, "state.vscdb");

    try {
      const db = new Database(stateDbPath, {
        readonly: true,
        fileMustExist: true,
      });

      const row = db
        .prepare(
          `
          SELECT value
          FROM ItemTable
          WHERE key LIKE '%activeSession%'
             OR key LIKE '%sessionId%'
             OR key LIKE '%conversation%'
          ORDER BY LENGTH(value) DESC
          LIMIT 1
          `,
        )
        .get() as ItemRow | undefined;

      db.close();

      this.currentConversationId = row ? extractConversationId(row.value) : null;
    } catch {
      this.currentConversationId = null;
    }
  }

  private async flushPendingSaves(): Promise<void> {
    if (this.pendingSaves.size === 0) {
      return;
    }

    await Promise.allSettled(Array.from(this.pendingSaves));
  }

  private async sendFinalCheckpoint(): Promise<void> {
    try {
      await this.ensureConnected();
      await this.daemonClient.sendMessage({
        type: "SaveSnapshot",
        payload: {
          snapshot_id: `final-checkpoint-${Date.now()}`,
          conversation_id: this.currentConversationId ?? undefined,
          data: {
            checkpoint: "final",
            conversation_id: this.currentConversationId,
            timestamp: Date.now(),
          },
        },
      });
    } catch {
      // Best-effort final checkpoint on shutdown.
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.daemonClient.isConnected()) {
      return;
    }

    await this.daemonClient.connect();
  }
}

function extractConversationId(value: string): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const fromObject =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).conversationId ??
          (parsed as Record<string, unknown>).sessionId ??
          (parsed as Record<string, unknown>).id
        : undefined;

    if (typeof fromObject === "string" && fromObject.length > 0) {
      return fromObject;
    }
  } catch {
    // Non-JSON value; try regex fallback.
  }

  const match = trimmed.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/,
  );
  if (match) {
    return match[0];
  }

  return trimmed;
}
