import * as vscode from "vscode";

export type AnchorStatus =
  | "protected"
  | "connecting"
  | "disconnected"
  | "recovering"
  | "mcp-error";

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "anchor.showHistory";
    this.item.show();
  }

  setStatus(status: AnchorStatus): void {
    if (status === "protected") {
      this.item.text = "Anchor: Protected [OK]";
      this.item.tooltip = "Anchor daemon connected and WAL protection active";
      this.item.backgroundColor = undefined;
      return;
    }

    if (status === "connecting") {
      this.item.text = "Anchor: Connecting...";
      this.item.tooltip = "Connecting to Anchor daemon";
      this.item.backgroundColor = undefined;
      return;
    }

    if (status === "recovering") {
      this.item.text = "Anchor: Recovering...";
      this.item.tooltip = "Anchor is checking and restoring context";
      this.item.backgroundColor = undefined;
      return;
    }

    if (status === "mcp-error") {
      this.item.text = "Anchor: MCP Error [WARN]";
      this.item.tooltip = "Daemon connected, but MCP tools are unavailable";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }

    this.item.text = "Anchor: Disconnected [WARN]";
    this.item.tooltip = "Anchor daemon unreachable";
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  }

  showRecoveryNotification(count: number): void {
    vscode.window.showInformationMessage(
      `Anchor recovered ${count} conversation${count === 1 ? "" : "s"}`,
    );
  }

  dispose(): void {
    this.item.dispose();
  }
}
