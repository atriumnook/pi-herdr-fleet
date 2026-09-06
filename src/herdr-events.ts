import net, { type Socket } from "node:net";
import { getHerdrSocketPath } from "./herdr.js";

export interface HerdrSocketEvent {
  event: string;
  data: Record<string, unknown>;
  receivedAt: number;
}

type EventHandler = (event: HerdrSocketEvent) => void | Promise<void>;
type ReadyHandler = () => void | Promise<void>;
type ErrorHandler = (error: Error) => void;

export function normalizeHerdrEventName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "pane_agent_status_changed":
      return "pane.agent_status_changed";
    case "pane_exited":
      return "pane.exited";
    case "pane_closed":
      return "pane.closed";
    case "pane_moved":
      return "pane.moved";
    default:
      return value;
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function decodeHerdrSocketEvent(
  message: Record<string, unknown>,
): Omit<HerdrSocketEvent, "receivedAt"> | undefined {
  const event = normalizeHerdrEventName(message.event ?? message.type);
  if (!event) return undefined;
  const rawData = message.data;
  const data =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : Object.fromEntries(
          Object.entries(message).filter(
            ([key]) => key !== "id" && key !== "event" && key !== "type",
          ),
        );
  return { event, data };
}

export class HerdrEventSubscriber {
  private panes = new Set<string>();
  private socket?: Socket;
  private buffer = "";
  private running = false;
  private generation = 0;
  private reconnectDelayMs = 250;
  private connected = false;
  private connecting = false;
  private reconfigure: Promise<void> = Promise.resolve();

  constructor(
    private readonly onEvent: EventHandler,
    private readonly onReady: ReadyHandler,
    private readonly onError: ErrorHandler = () => {},
  ) {}

  private guardError(error: unknown): void {
    // onError runs inside socket event handlers and fire-and-forget promise
    // chains; letting it throw (or reject) would crash the host process.
    try {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Swallow: a throwing error handler must not kill the agent.
    }
  }

  start(): Promise<void> {
    this.running = true;
    this.reconfigure = this.reconfigure
      .catch(() => undefined)
      .then(() => this.reconnect());
    return this.reconfigure;
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.socket?.destroy();
    this.socket = undefined;
    this.connected = false;
  }

  ensurePanes(paneIds: Iterable<string>): Promise<void> {
    const next = new Set([...paneIds].filter(Boolean));
    const changed = !sameSet(this.panes, next);
    this.panes = next;
    if (!this.running) return Promise.resolve();
    // While a connection attempt is in flight, additional ensurePanes calls
    // (registry watcher fires on every save) must be no-ops. Chaining another
    // reconnect destroys the in-flight socket before the handshake completes,
    // which wedges `connected=false` forever and storms the server.
    if (!changed && (this.connected || this.connecting))
      return this.reconfigure;
    if (this.connecting) return this.reconfigure;
    this.connecting = true;
    this.reconfigure = this.reconfigure
      .catch(() => undefined)
      .then(() => this.reconnect())
      .catch((error) => {
        // Sync callers (registry watcher, socket events) fire-and-forget this
        // promise; a failed reconfiguration must surface as onError, not as an
        // unhandled rejection that crashes the process.
        this.guardError(error);
      })
      .finally(() => {
        this.connecting = false;
      });
    return this.reconfigure;
  }

  private async reconnect(): Promise<void> {
    if (!this.running) return;
    const socketPath = getHerdrSocketPath();
    if (!socketPath) {
      throw new Error(
        "HERDR_SOCKET_PATH is not set; Herdr socket event subscriptions are unavailable.",
      );
    }

    const generation = ++this.generation;
    this.socket?.destroy();
    this.connected = false;
    this.buffer = "";

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      this.socket = socket;
      let acknowledged = false;
      const requestId = `pi_mesh_${process.pid}_${generation}`;

      const failBeforeReady = (error: Error): void => {
        clearTimeout(handshakeTimeout);
        if (!acknowledged) reject(error);
        this.guardError(error);
      };

      // A wedged handshake must not hold the reconfigure chain forever.
      const handshakeTimeout = setTimeout(() => {
        failBeforeReady(
          new Error("Herdr event subscription handshake timed out."),
        );
        socket.destroy();
      }, 10_000);

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        const subscriptions: Array<Record<string, string>> = [
          { type: "pane.exited" },
          { type: "pane.closed" },
          { type: "pane.moved" },
          ...[...this.panes].map((paneId) => ({
            type: "pane.agent_status_changed",
            pane_id: paneId,
          })),
        ];
        socket.write(
          `${JSON.stringify({ id: requestId, method: "events.subscribe", params: { subscriptions } })}\n`,
        );
      });

      socket.on("data", (chunk: string) => {
        if (generation !== this.generation) return;
        this.buffer += chunk;
        while (true) {
          const newline = this.buffer.indexOf("\n");
          if (newline < 0) break;
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (!line) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (message.id === requestId) {
            if (message.error) {
              const error = new Error(
                `Herdr events.subscribe failed: ${JSON.stringify(message.error)}`,
              );
              failBeforeReady(error);
              socket.destroy();
              return;
            }
            if (!acknowledged) {
              acknowledged = true;
              clearTimeout(handshakeTimeout);
              this.connected = true;
              this.reconnectDelayMs = 250;
              resolve();
              void this.onReady();
            }
            continue;
          }

          const decoded = decodeHerdrSocketEvent(message);
          if (!decoded) continue;
          void Promise.resolve()
            .then(() => this.onEvent({ ...decoded, receivedAt: Date.now() }))
            .catch((error) => this.guardError(error));
        }
      });

      socket.on("error", (error) => {
        try {
          failBeforeReady(error);
        } catch (guarded) {
          this.guardError(guarded);
        }
      });
      socket.on("close", () => {
        try {
          if (generation !== this.generation || !this.running) return;
          this.connected = false;
          if (!acknowledged)
            reject(
              new Error(
                "Herdr event socket closed before subscription acknowledgement.",
              ),
            );
          else
            this.guardError(
              new Error("Herdr event socket disconnected; reconnecting."),
            );
          const delay = this.reconnectDelayMs;
          this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 5000);
          setTimeout(() => {
            if (!this.running || generation !== this.generation) return;
            void this.reconnect().catch((error) => this.guardError(error));
          }, delay);
        } catch (guarded) {
          this.guardError(guarded);
        }
      });
    });
  }
}
