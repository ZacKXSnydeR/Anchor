import * as net from "net";

import { DaemonClient } from "../src/ipc/daemon-client";

jest.mock("net", () => {
  let attempts = 0;

  class MockSocket {
    public destroyed = false;
    private readonly handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

    setEncoding(): this {
      return this;
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      if (!this.handlers[event]) {
        this.handlers[event] = [];
      }
      this.handlers[event].push(handler);
      return this;
    }

    once(event: string, handler: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]) => {
        this.off(event, wrapped);
        handler(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers[event] = (this.handlers[event] ?? []).filter((cb) => cb !== handler);
      return this;
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers[event] ?? []) {
        handler(...args);
      }
    }

    connect(): this {
      attempts += 1;
      if (attempts === 1) {
        this.emit("error", new Error("first attempt failed"));
      } else {
        this.emit("connect");
      }
      return this;
    }

    write(_data: string, callback?: (error?: Error) => void): boolean {
      if (callback) {
        callback();
      }
      return true;
    }

    end(): this {
      this.destroyed = true;
      return this;
    }

    destroy(): this {
      this.destroyed = true;
      this.emit("close");
      return this;
    }
  }

  return { Socket: jest.fn(() => new MockSocket()) };
});

describe("DaemonClient", () => {
  test("retries connect with exponential backoff and eventually connects", async () => {
    jest.useFakeTimers();

    const client = new DaemonClient();
    const connectPromise = client.connect();

    await jest.advanceTimersByTimeAsync(300);
    await connectPromise;

    const mockedNet = net as unknown as { Socket: jest.Mock };
    expect(mockedNet.Socket).toHaveBeenCalledTimes(2);
    expect(client.isConnected()).toBe(true);

    client.dispose();
    jest.useRealTimers();
  });
});
