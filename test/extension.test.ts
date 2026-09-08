import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import herdrFleetExtension from "../src/index.js";
import { OUTSIDE_HERDR_WARNING } from "../src/herdr.js";

function fakePi(): {
  pi: ExtensionAPI;
  notifications: Array<{ message: string; type?: string }>;
  commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>;
  tools: string[];
  handlers: Map<string, (...args: never[]) => unknown>;
} {
  const notifications: Array<{ message: string; type?: string }> = [];
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => unknown }
  >();
  const tools: string[] = [];
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const pi = {
    on(event: string, handler: (...args: never[]) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: ExtensionContext) => unknown },
    ) {
      commands.set(name, options);
    },
    registerTool() {
      tools.push("tool");
    },
    getThinkingLevel: () => "off",
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  return { pi, notifications, commands, tools, handlers };
}

function fakeCtx(
  notifications: Array<{ message: string; type?: string }>,
): ExtensionContext {
  return {
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;
}

describe("extension silent-failure warnings", () => {
  const previousEnv = process.env.HERDR_ENV;
  const previousPane = process.env.HERDR_PANE_ID;

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousEnv;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
  });

  test("outside Herdr notifies once on session_start and again on /fleet, without registering tools", async () => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    const { pi, notifications, commands, tools, handlers } = fakePi();
    herdrFleetExtension(pi);

    expect(tools).toHaveLength(0);
    expect(commands.has("fleet")).toBe(true);

    const ctx = fakeCtx(notifications);
    const start = handlers.get("session_start") as
      | ((event: unknown, ctx: ExtensionContext) => unknown)
      | undefined;
    await start?.({}, ctx);
    await start?.({}, ctx);
    expect(notifications).toEqual([
      { message: OUTSIDE_HERDR_WARNING, type: "warning" },
    ]);

    await commands.get("fleet")?.handler("", ctx);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toEqual({
      message: OUTSIDE_HERDR_WARNING,
      type: "warning",
    });
  });
});
