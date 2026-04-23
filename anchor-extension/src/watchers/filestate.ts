import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { DaemonClient } from "../ipc/daemon-client";

type SnapshotState = {
  snapshotId: string;
  filePath: string;
  contentBefore: string;
  operation: "ai_edit";
  startedAt: number;
  completionTimer?: NodeJS.Timeout;
};

type FileStateWatcherOptions = {
  getCurrentConversationId?: () => string | null;
  onAiEditStart?: (description: string) => Promise<void>;
};

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_FAILURE_THRESHOLD = 3;
const AI_EDIT_IDLE_COMPLETE_MS = 1_200;
const AI_ACTIVITY_WINDOW_MS = 8_000;

export class FileStateWatcher implements vscode.Disposable {
  private readonly antigravityPattern = new vscode.RelativePattern(
    os.homedir(),
    "**/.antigravity/**",
  );

  private readonly pendingSends = new Set<Promise<void>>();
  private readonly snapshotStatesByFile = new Map<string, SnapshotState>();

  private antigravityWatcher: vscode.FileSystemWatcher | undefined;
  private documentSubscription: vscode.Disposable | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private aiActivityUntil = 0;
  private heartbeatFailures = 0;

  constructor(
    private readonly daemonClient: DaemonClient,
    private readonly options: FileStateWatcherOptions = {},
  ) {}

  start(): void {
    if (!this.antigravityWatcher) {
      this.antigravityWatcher = vscode.workspace.createFileSystemWatcher(
        this.antigravityPattern,
      );

      const onAiActivity = (uri: vscode.Uri) => {
        if (!isAntigravityActivityPath(uri.fsPath)) {
          return;
        }

        this.beginAiEditWindow(uri.fsPath);
      };

      this.antigravityWatcher.onDidCreate(onAiActivity);
      this.antigravityWatcher.onDidChange(onAiActivity);
      this.antigravityWatcher.onDidDelete(onAiActivity);
    }

    if (!this.documentSubscription) {
      this.documentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
        if (!this.isAiEditWindowActive()) {
          return;
        }

        this.trackPending(this.handleDocumentChange(event));
      });
    }

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.trackPending(this.sendHeartbeat());
      }, HEARTBEAT_INTERVAL_MS);
    }
  }

  async deactivate(): Promise<void> {
    await this.flushPendingSaves();
  }

  dispose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.documentSubscription?.dispose();
    this.antigravityWatcher?.dispose();

    this.documentSubscription = undefined;
    this.antigravityWatcher = undefined;

    for (const state of this.snapshotStatesByFile.values()) {
      if (state.completionTimer) {
        clearTimeout(state.completionTimer);
      }
    }
    this.snapshotStatesByFile.clear();
  }

  private beginAiEditWindow(activityPath: string): void {
    this.aiActivityUntil = Date.now() + AI_ACTIVITY_WINDOW_MS;

    const description = path.basename(activityPath);
    if (this.options.onAiEditStart) {
      this.trackPending(this.options.onAiEditStart(description));
    }

    for (const doc of vscode.workspace.textDocuments) {
      if (!isTrackableDocument(doc)) {
        continue;
      }

      if (!this.snapshotStatesByFile.has(doc.uri.fsPath)) {
        this.trackPending(this.createPreEditSnapshot(doc).then(() => undefined));
      }
    }
  }

  private isAiEditWindowActive(): boolean {
    return Date.now() <= this.aiActivityUntil;
  }

  private async handleDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
    const doc = event.document;
    if (!isTrackableDocument(doc)) {
      return;
    }

    let snapshotState = this.snapshotStatesByFile.get(doc.uri.fsPath);
    if (!snapshotState) {
      snapshotState = await this.createPreEditSnapshot(doc);
      if (!snapshotState) {
        return;
      }
    }

    if (snapshotState.completionTimer) {
      clearTimeout(snapshotState.completionTimer);
    }

    snapshotState.completionTimer = setTimeout(() => {
      this.trackPending(this.finalizePostEditSnapshot(doc.uri));
    }, AI_EDIT_IDLE_COMPLETE_MS);
  }

  private async createPreEditSnapshot(
    document: vscode.TextDocument,
  ): Promise<SnapshotState | undefined> {
    const startedAt = Date.now();
    const snapshotState: SnapshotState = {
      snapshotId: buildSnapshotId(document.uri.fsPath, startedAt),
      filePath: document.uri.fsPath,
      contentBefore: document.getText(),
      operation: "ai_edit",
      startedAt,
    };

    this.snapshotStatesByFile.set(document.uri.fsPath, snapshotState);

    try {
      await this.ensureConnected();

      await this.daemonClient.sendMessage({
        type: "SaveSnapshot",
        payload: {
          snapshot_id: snapshotState.snapshotId,
          conversation_id: this.options.getCurrentConversationId?.() ?? undefined,
          data: {
            file_path: snapshotState.filePath,
            content_before: snapshotState.contentBefore,
            content_after: null,
            operation: snapshotState.operation,
            timestamp: snapshotState.startedAt,
            phase: "pre_edit_snapshot",
          },
        },
      });

      return snapshotState;
    } catch {
      this.snapshotStatesByFile.delete(document.uri.fsPath);
      return undefined;
    }
  }

  private async finalizePostEditSnapshot(uri: vscode.Uri): Promise<void> {
    const snapshotState = this.snapshotStatesByFile.get(uri.fsPath);
    if (!snapshotState) {
      return;
    }

    const doc = vscode.workspace.textDocuments.find((item) => item.uri.fsPath === uri.fsPath);
    const contentAfter = doc ? doc.getText() : null;

    try {
      await this.ensureConnected();
      await this.daemonClient.sendMessage({
        type: "SaveSnapshot",
        payload: {
          snapshot_id: snapshotState.snapshotId,
          conversation_id: this.options.getCurrentConversationId?.() ?? undefined,
          data: {
            file_path: snapshotState.filePath,
            content_before: snapshotState.contentBefore,
            content_after: contentAfter,
            operation: snapshotState.operation,
            timestamp: Date.now(),
            phase: "post_edit_snapshot",
          },
        },
      });
    } finally {
      this.snapshotStatesByFile.delete(uri.fsPath);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      await this.ensureConnected();
      await this.daemonClient.sendMessage({ type: "Ping" });
      this.heartbeatFailures = 0;
    } catch {
      this.heartbeatFailures += 1;

      if (this.heartbeatFailures >= HEARTBEAT_FAILURE_THRESHOLD) {
        this.heartbeatFailures = 0;
        void vscode.window.showWarningMessage(
          "Anchor heartbeat failed 3 times; daemon may mark this session as crashed.",
        );
      }
    }
  }

  private async flushPendingSaves(): Promise<void> {
    if (this.pendingSends.size === 0) {
      return;
    }

    await Promise.allSettled(Array.from(this.pendingSends));
  }

  private trackPending(task: Promise<void>): void {
    this.pendingSends.add(task);
    task.finally(() => {
      this.pendingSends.delete(task);
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.daemonClient.isConnected()) {
      return;
    }

    await this.daemonClient.connect();
  }
}

function buildSnapshotId(filePath: string, timestamp: number): string {
  const normalized = Buffer.from(filePath).toString("hex").slice(0, 24);
  return `ai-${timestamp}-${normalized}`;
}

function isTrackableDocument(document: vscode.TextDocument): boolean {
  if (document.isUntitled) {
    return false;
  }

  if (document.uri.scheme !== "file") {
    return false;
  }

  return Boolean(vscode.workspace.getWorkspaceFolder(document.uri));
}

function isAntigravityActivityPath(fsPath: string): boolean {
  const normalized = fsPath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/.antigravity/context_state/") ||
    normalized.endsWith("/.antigravity/state.vscdb") ||
    normalized.includes("/.antigravity/agents/") ||
    normalized.includes("/.antigravity/sessions/")
  );
}
