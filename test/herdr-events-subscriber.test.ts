import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { HerdrEventSubscriber } from "../src/herdr-events.js";

interface SubscribeCall {
  paneIds: string[];
  id: string;
  socket: net.Socket;
  acked: boolean;
}

class MockHerdrServer {
  connectionCount = 0;
  subscribeCalls: SubscribeCall[] = [];
  autoAck = true;
  readonly socketPath: string;
  private readonly dir: string;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();

  static async start(): Promise<MockHerdrServer> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-evt-"));
    const socketPath = path.join(dir, "herdr.sock");
    const mock = new MockHerdrServer(dir, socketPath);
    await new Promise<void>((resolve, reject) => {
      mock.server.once("error", reject);
      mock.server.listen(socketPath, () => resolve());
    });
    return mock;
  }

  private constructor(dir: string, socketPath: string) {
    this.dir = dir;
    this.socketPath = socketPath;
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  private onConnection(socket: net.Socket): void {
    this.connectionCount += 1;
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.method !== "events.subscribe") continue;
        const params = message.params as
          | { subscriptions?: Array<{ type?: string; pane_id?: string }> }
          | undefined;
        const paneIds = (params?.subscriptions ?? [])
          .filter(
            (item) =>
              item.type === "pane.agent_status_changed" &&
              typeof item.pane_id === "string",
          )
          .map((item) => item.pane_id as string);
        const call: SubscribeCall = {
          paneIds,
          id: String(message.id),
          socket,
          acked: false,
        };
        this.subscribeCalls.push(call);
        if (this.autoAck) this.ack(call);
      }
    });
    socket.on("close", () => this.sockets.delete(socket));
  }

  ack(call: SubscribeCall): void {
    if (call.acked) return;
    call.acked = true;
    if (!call.socket.destroyed) {
      call.socket.write(`${JSON.stringify({ id: call.id, result: {} })}\n`);
    }
  }

  ackPending(): void {
    for (const call of this.subscribeCalls) {
      if (!call.acked && !call.socket.destroyed) this.ack(call);
    }
  }

  dropAll(): void {
    for (const socket of [...this.sockets]) socket.destroy();
  }

  pendingCount(): number {
    return this.subscribeCalls.filter(
      (call) => !call.acked && !call.socket.destroyed,
    ).length;
  }

  close(): void {
    for (const socket of [...this.sockets]) socket.destroy();
    this.server.close();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_500,
  message = "timed out waiting for condition",
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const previousSocket = process.env.HERDR_SOCKET_PATH;
const subscribers: HerdrEventSubscriber[] = [];
const servers: MockHerdrServer[] = [];

afterEach(() => {
  for (const subscriber of subscribers.splice(0)) subscriber.stop();
  for (const server of servers.splice(0)) server.close();
  if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
  else process.env.HERDR_SOCKET_PATH = previousSocket;
});

describe("HerdrEventSubscriber connecting gate", () => {
  test(
    "start() and ensurePanes during handshake coalesce; follow-up subscribes the new pane",
    async () => {
      const mock = await MockHerdrServer.start();
      servers.push(mock);
      mock.autoAck = false;
      process.env.HERDR_SOCKET_PATH = mock.socketPath;

      const ready: number[] = [];
      const subscriber = new HerdrEventSubscriber(
        () => {},
        () => {
          ready.push(Date.now());
        },
      );
      subscribers.push(subscriber);

      await subscriber.ensurePanes(["w1:p1"]);
      const started = subscriber.start();
      await waitFor(
        () => mock.pendingCount() === 1,
        1_500,
        "did not receive the initial subscribe",
      );
      expect(mock.connectionCount).toBe(1);
      expect(mock.subscribeCalls[0]?.paneIds).toEqual(["w1:p1"]);

      for (let i = 2; i <= 6; i++) {
        await subscriber.ensurePanes(
          Array.from({ length: i }, (_, index) => `w1:p${index + 1}`),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(mock.connectionCount).toBe(1);
      expect(ready).toHaveLength(0);

      mock.autoAck = true;
      mock.ackPending();
      await started;

      const last = mock.subscribeCalls.at(-1);
      expect(last?.paneIds).toEqual([
        "w1:p1",
        "w1:p2",
        "w1:p3",
        "w1:p4",
        "w1:p5",
        "w1:p6",
      ]);
      expect(ready.length).toBeGreaterThanOrEqual(1);
      expect(mock.subscribeCalls.length).toBeGreaterThanOrEqual(2);
      expect(mock.connectionCount).toBeLessThanOrEqual(3);
    },
    5_000,
  );

  test(
    "socket close reconnects through the gate; ensurePanes during reconnect does not storm",
    async () => {
      const mock = await MockHerdrServer.start();
      servers.push(mock);
      process.env.HERDR_SOCKET_PATH = mock.socketPath;

      const ready: number[] = [];
      const subscriber = new HerdrEventSubscriber(
        () => {},
        () => {
          ready.push(Date.now());
        },
      );
      subscribers.push(subscriber);

      await subscriber.ensurePanes(["w1:p1"]);
      await subscriber.start();
      expect(ready).toHaveLength(1);
      const afterStart = mock.connectionCount;

      mock.autoAck = false;
      mock.dropAll();
      await waitFor(
        () => mock.pendingCount() === 1,
        2_000,
        "did not reconnect after socket close",
      );
      expect(mock.connectionCount).toBe(afterStart + 1);

      await subscriber.ensurePanes(["w1:p1", "w1:p2"]);
      await subscriber.ensurePanes(["w1:p1", "w1:p2", "w1:p3"]);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(mock.connectionCount).toBe(afterStart + 1);

      mock.autoAck = true;
      mock.ackPending();
      await waitFor(
        () =>
          mock.subscribeCalls.some((call) => call.paneIds.includes("w1:p3")),
        1_500,
        "reconnect handshake did not pick up panes added during close reconnect",
      );
      await waitFor(() => ready.length >= 2, 1_500, "onReady after reconnect");
      expect(mock.connectionCount).toBeLessThanOrEqual(afterStart + 3);
      expect(
        mock.subscribeCalls.some((call) =>
          call.paneIds.includes("w1:p3") &&
          call.paneIds.includes("w1:p2") &&
          call.paneIds.includes("w1:p1"),
        ),
      ).toBe(true);
    },
    5_000,
  );

  test(
    "start() sets the connecting gate so a concurrent ensurePanes cannot destroy the handshake",
    async () => {
      const mock = await MockHerdrServer.start();
      servers.push(mock);
      mock.autoAck = false;
      process.env.HERDR_SOCKET_PATH = mock.socketPath;

      const ready: number[] = [];
      const subscriber = new HerdrEventSubscriber(
        () => {},
        () => {
          ready.push(Date.now());
        },
      );
      subscribers.push(subscriber);

      const started = subscriber.start();
      await waitFor(
        () => mock.connectionCount === 1,
        1_500,
        "start() did not connect",
      );
      await waitFor(
        () => mock.pendingCount() === 1,
        1_500,
        "start() did not send subscribe",
      );
      await subscriber.ensurePanes(["w1:p1"]);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(mock.connectionCount).toBe(1);
      expect(ready).toHaveLength(0);

      mock.autoAck = true;
      mock.ackPending();
      await started;
      expect(ready.length).toBeGreaterThanOrEqual(1);
      expect(
        mock.subscribeCalls.some((call) => call.paneIds.includes("w1:p1")),
      ).toBe(true);
    },
    5_000,
  );
});
