import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import simpleGit, { DefaultLogFields, ListLogLine, SimpleGit } from "simple-git";

export type GitCommit = {
  hash: string;
  date: string;
  message: string;
  authorName: string;
};

const AUTO_COMMIT_INTERVAL_MS = 2 * 60 * 1000;

export class AutoCommitManager implements vscode.Disposable {
  private workspacePath: string | undefined;
  private git: SimpleGit | undefined;
  private timer: NodeJS.Timeout | undefined;

  async initialize(workspacePath: string): Promise<void> {
    this.workspacePath = workspacePath;

    const gitDir = path.join(workspacePath, ".git");
    this.git = simpleGit({ baseDir: workspacePath });

    if (fs.existsSync(gitDir)) {
      return;
    }

    const selected = await vscode.window.showInformationMessage(
      "Anchor: This workspace is not a git repository. Initialize one for local snapshots?",
      "Initialize",
      "Later",
    );

    if (selected !== "Initialize") {
      return;
    }

    await this.git.init();
    await this.git.addConfig("user.name", "Anchor Auto Commit", false, "local");
    await this.git.addConfig("user.email", "anchor@local", false, "local");
    void vscode.window.showInformationMessage("Anchor initialized local git repository");
  }

  scheduleAutoCommit(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(() => {
      void this.runAutoCommit();
    }, AUTO_COMMIT_INTERVAL_MS);
  }

  async commitBeforeAiEdit(description: string): Promise<void> {
    if (!this.git) {
      return;
    }

    await this.commitIfNeeded(`anchor: pre-ai-edit snapshot - ${description}`);
  }

  async getRecentSnapshots(limit: number): Promise<GitCommit[]> {
    if (!this.git) {
      return [];
    }

    const count = Math.max(1, limit);
    const log = await this.git.log({ maxCount: count });
    return log.all.map((entry) => mapCommit(entry));
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runAutoCommit(): Promise<void> {
    if (!this.git) {
      return;
    }

    const now = new Date();
    const stamp = now.toTimeString().split(" ")[0];
    await this.commitIfNeeded(`anchor: auto-save ${stamp}`);
  }

  private async commitIfNeeded(message: string): Promise<void> {
    if (!this.git) {
      return;
    }

    const status = await this.git.status();
    const hasChanges =
      status.not_added.length > 0 ||
      status.created.length > 0 ||
      status.deleted.length > 0 ||
      status.modified.length > 0 ||
      status.renamed.length > 0;

    if (!hasChanges) {
      return;
    }

    await this.git.add("-A");

    try {
      await this.git.commit(message);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      if (errorText.toLowerCase().includes("nothing to commit")) {
        return;
      }

      throw error;
    }
  }
}

function mapCommit(entry: DefaultLogFields & ListLogLine): GitCommit {
  return {
    hash: entry.hash,
    date: entry.date,
    message: entry.message,
    authorName: entry.author_name,
  };
}
