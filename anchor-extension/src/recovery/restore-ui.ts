import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { DaemonClient } from "../ipc/daemon-client";
import { PbFileReader, RecoveredConversation } from "./pb-reader";

type DashboardMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "restore"; id: string }
  | { type: "export"; id: string }
  | { type: "copy"; id: string };

type RecoverySummary = {
  id: string;
  timestamp: number;
  recoveredMessageCount: number;
};

export class RecoveryDashboard implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly pbReader: PbFileReader;
  private recoveredById = new Map<string, RecoveredConversation>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly daemonClient: DaemonClient,
  ) {
    this.pbReader = new PbFileReader(daemonClient);
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.refreshData();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "anchorRecovery",
      "Anchor Recovery Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: DashboardMessage) => {
      void this.handleMessage(message);
    });

    this.panel.webview.html = this.renderHtml(this.panel.webview);
    await this.refreshData();
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.recoveredById.clear();
  }

  private async handleMessage(message: DashboardMessage): Promise<void> {
    if (message.type === "ready" || message.type === "refresh") {
      await this.refreshData();
      return;
    }

    const recovery = this.recoveredById.get(message.id);
    if (!recovery) {
      void vscode.window.showWarningMessage(`Recovery entry not found: ${message.id}`);
      return;
    }

    if (message.type === "restore") {
      await this.restoreConversation(recovery);
      return;
    }

    if (message.type === "export") {
      await this.exportConversation(recovery);
      return;
    }

    if (message.type === "copy") {
      await vscode.env.clipboard.writeText(recovery.markdown);
      void vscode.window.showInformationMessage(`Copied recovery markdown for ${recovery.id}`);
    }
  }

  private async refreshData(): Promise<void> {
    const antigravityDir = path.join(os.homedir(), ".antigravity");
    const pbFiles = this.pbReader.listPbFiles(antigravityDir).slice(0, 200);

    const recoveries = await Promise.all(
      pbFiles.map(async (fileMeta) => {
        try {
          return await this.pbReader.recoverConversation(fileMeta.path);
        } catch {
          return {
            id: fileMeta.id,
            pbPath: fileMeta.path,
            timestamp: fileMeta.modifiedAt,
            messages: [],
            recoveryMethod: "raw_binary_scan",
            confidence: 0,
            recoveredTextBlocks: [],
            recoveredMessageCount: 0,
            daemonData: null,
            markdown: `# Recovered Conversation ${fileMeta.id}\n\nUnable to parse this .pb file.`,
          } as RecoveredConversation;
        }
      }),
    );

    this.recoveredById = new Map(recoveries.map((item) => [item.id, item]));

    const summaries: RecoverySummary[] = recoveries.map((item) => ({
      id: item.id,
      timestamp: item.timestamp,
      recoveredMessageCount: item.recoveredMessageCount,
    }));

    await this.panel?.webview.postMessage({
      type: "data",
      items: summaries,
    });
  }

  private async restoreConversation(recovery: RecoveredConversation): Promise<void> {
    const recoveredDir = path.join(os.homedir(), ".anchor", "recovered");
    await fs.promises.mkdir(recoveredDir, { recursive: true });

    const filePath = path.join(recoveredDir, `${recovery.id}.md`);
    await fs.promises.writeFile(filePath, recovery.markdown, "utf8");

    void vscode.window.showInformationMessage(`Restored recovery markdown to ${filePath}`);
  }

  private async exportConversation(recovery: RecoveredConversation): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      saveLabel: "Export recovery as Markdown",
      defaultUri: vscode.Uri.file(`${recovery.id}.md`),
      filters: {
        Markdown: ["md"],
      },
    });

    if (!target) {
      return;
    }

    await vscode.workspace.fs.writeFile(target, Buffer.from(recovery.markdown, "utf8"));
    void vscode.window.showInformationMessage(`Exported recovery markdown for ${recovery.id}`);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Anchor Recovery Dashboard</title>
    <style>
      :root {
        --bg: #f6f8fb;
        --panel: #ffffff;
        --ink: #16202a;
        --muted: #5d6b7a;
        --line: #d9e0e8;
        --accent: #0f6bdc;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", "SF Pro Text", sans-serif;
        background: linear-gradient(180deg, #eef3fb 0%, var(--bg) 60%, #edf2f9 100%);
        color: var(--ink);
      }
      .wrap {
        max-width: 980px;
        margin: 0 auto;
        padding: 20px;
      }
      .hero {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
      }
      .hero h1 {
        margin: 0;
        font-size: 20px;
      }
      .hero p {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 13px;
      }
      .btn {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 8px 12px;
        font-size: 12px;
        cursor: pointer;
        background: #fff;
      }
      .btn.primary {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .list {
        display: grid;
        gap: 12px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
        box-shadow: 0 8px 22px rgba(28, 43, 62, 0.06);
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
      }
      .id {
        font-weight: 600;
        font-size: 13px;
      }
      .meta {
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
      }
      .actions {
        display: flex;
        gap: 8px;
        margin-top: 10px;
        flex-wrap: wrap;
      }
      .empty {
        background: var(--panel);
        border: 1px dashed var(--line);
        border-radius: 12px;
        padding: 18px;
        color: var(--muted);
      }
      @media (max-width: 680px) {
        .row {
          flex-direction: column;
          align-items: flex-start;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="hero">
        <div>
          <h1>Anchor Recovery Dashboard</h1>
          <p>.pb extraction + daemon cross-reference recovery</p>
        </div>
        <button class="btn primary" id="refresh">Refresh</button>
      </div>
      <div id="list" class="list"></div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const list = document.getElementById("list");
      const refresh = document.getElementById("refresh");

      refresh.addEventListener("click", () => {
        vscode.postMessage({ type: "refresh" });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "data") {
          return;
        }

        renderList(message.items || []);
      });

      function renderList(items) {
        if (!Array.isArray(items) || items.length === 0) {
          list.innerHTML = '<div class="empty">No .pb conversations found in ~/.antigravity/conversations/.</div>';
          return;
        }

        list.innerHTML = items
          .map((item) => {
            const id = escapeHtml(item.id);
            const attrId = escapeAttr(item.id);
            const count = Number(item.recoveredMessageCount) || 0;
            const time = new Date(Number(item.timestamp) || Date.now()).toLocaleString();

            return (
              '<article class="card">' +
                '<div class="row">' +
                  '<div>' +
                    '<div class="id">' + id + '</div>' +
                    '<div class="meta">Recovered messages: ' + count + '</div>' +
                  '</div>' +
                  '<div class="meta">' + time + '</div>' +
                '</div>' +
                '<div class="actions">' +
                  '<button class="btn" data-action="restore" data-id="' + attrId + '">Restore</button>' +
                  '<button class="btn" data-action="export" data-id="' + attrId + '">Export as Markdown</button>' +
                  '<button class="btn" data-action="copy" data-id="' + attrId + '">Copy to Clipboard</button>' +
                '</div>' +
              '</article>'
            );
          })
          .join("");
      }

      list.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const button = target.closest("button[data-action]");
        if (!(button instanceof HTMLElement)) {
          return;
        }

        const action = button.getAttribute("data-action");
        const id = button.getAttribute("data-id");
        if (!action || !id) {
          return;
        }

        vscode.postMessage({ type: action, id });
      });

      function escapeHtml(input) {
        return String(input)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      function escapeAttr(input) {
        return escapeHtml(input).replace(/"/g, "&quot;");
      }

      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
  }
}
