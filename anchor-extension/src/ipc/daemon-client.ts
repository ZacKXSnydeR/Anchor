import * as net from "net";

export type AnchorMessage =
  | { type: "Ping" }
  | {
      type: "SaveConversation";
      payload: { conversation_id: string; data: unknown };
    }
  | {
      type: "SaveSnapshot";
      payload: { snapshot_id: string; conversation_id?: string; data: unknown };
    }
  | { type: "GetConversations" }
  | { type: "Recover"; payload: { conversation_id: string } }
  | { type: "RunStateRepair" }
  | { type: "ReadFile"; payload: { path: string; encoding?: "utf8" | "base64" } }
  | { type: "WriteFile"; payload: { path: string; content: string; operation_hint?: string } }
  | {
      type: "EditFile";
      payload: { path: string; old_str: string; new_str: string; operation_hint?: string };
    }
  | { type: "Pong" }
  | { type: "Ok" }
  | { type: "Error"; payload: string }
  | { type: "Data"; payload: unknown };

export type AnchorResponse =
  | { type: "Pong" }
  | { type: "Ok" }
  | { type: "Error"; payload: string }
  | { type: "Data"; payload: unknown };

type PendingRequest = {
  resolve: (response: AnchorResponse) => void;
  reject: (error: Error) => void;
};

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 250;

export class DaemonClient {
  private socket: net.Socket | undefined;
  private messageHandlers: Array<(msg: AnchorResponse) => void> = [];
  private pending: PendingRequest[] = [];
  private readBuffer = "";
  private connected = false;

  async connect(): Promise<void> {
    if (this.connected && this.socket && !this.socket.destroyed) {
      return;
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = toError(error);
        const delay = BASE_BACKOFF_MS * Math.pow(2, attempt);
        await wait(delay);
      }
    }

    throw lastError ?? new Error("Unable to connect to Anchor daemon");
  }

  async sendMessage(msg: AnchorMessage): Promise<AnchorResponse> {
    if (!this.connected || !this.socket || this.socket.destroyed) {
      throw new Error("Daemon client is not connected");
    }

    return new Promise<AnchorResponse>((resolve, reject) => {
      this.pending.push({ resolve, reject });

      const serialized = JSON.stringify(msg);
      this.socket?.write(`${serialized}\n`, (error) => {
        if (error) {
          const pending = this.pending.pop();
          pending?.reject(error);
        }
      });
    });
  }

  onMessage(handler: (msg: AnchorResponse) => void): void {
    this.messageHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected && Boolean(this.socket) && !this.socket?.destroyed;
  }

  dispose(): void {
    this.connected = false;

    while (this.pending.length > 0) {
      this.pending.shift()?.reject(new Error("Daemon client disposed"));
    }

    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
      this.socket.destroy();
    }

    this.socket = undefined;
    this.readBuffer = "";
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;

      socket.setEncoding("utf8");

      socket.on("data", (chunk: string) => {
        this.handleData(chunk);
      });

      socket.once("connect", () => {
        this.socket = socket;
        this.connected = true;
        settled = true;
        resolve();
      });

      socket.once("error", (error) => {
        this.connected = false;
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.on("close", () => {
        this.connected = false;
      });

      if (process.platform === "win32") {
        socket.connect("\\\\.\\pipe\\anchor");
      } else {
        socket.connect("/tmp/anchor.sock");
      }
    });
  }

  private handleData(chunk: string): void {
    this.readBuffer += chunk;

    const lines = this.readBuffer.split("\n");
    this.readBuffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as AnchorResponse;
        this.messageHandlers.forEach((handler) => handler(parsed));

        const request = this.pending.shift();
        request?.resolve(parsed);
      } catch (error) {
        const request = this.pending.shift();
        request?.reject(toError(error));
      }
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
