import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { HerdrCommandError } from "../src/herdr.js";
import { HerdrEventSubscriber } from "../src/herdr-events.js";
import { Orchestrator } from "../src/orchestrator.js";
import { RunRegistry } from "../src/registry.js";
import type {
  AgentMetadata,
  AgentRuntime,
  CreateLocationOptions,
  RuntimeAgentState,
  RuntimeLocation,
} from "../src/runtime.js";
import type {
  AgentDefinition,
  AgentRun,
  AgentState,
  FleetConfig,
} from "../src/types.js";

class FakeRuntime implements AgentRuntime {
  readonly kind = "herdr" as const;
  closed: string[] = [];
  prompts: Array<{ name: string; text: string }> = [];
  startCalls: Array<{ name: string; paneId: string; agentArgs: string[] }> = [];
  createLocationDelayMs = 0;
  promptStatus: AgentState = "working";
  getStatus: AgentState = "working";
  startImpl?: AgentRuntime["start"];
  paneExistsImpl?: (paneId: string) => Promise<boolean>;
  private locations = 0;

  async createLocation(
    options: CreateLocationOptions,
  ): Promise<RuntimeLocation> {
    if (this.createLocationDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.createLocationDelayMs),
      );
    }
    this.locations += 1;
    return { paneId: `w1:p${this.locations}`, cwd: options.cwd };
  }

  async start(
    name: string,
    paneId: string,
    agentArgs: string[],
  ): Promise<RuntimeAgentState> {
    this.startCalls.push({ name, paneId, agentArgs });
    if (this.startImpl) return this.startImpl(name, paneId, agentArgs);
    return { status: "idle" };
  }

  async closePane(paneId: string): Promise<void> {
    this.closed.push(paneId);
  }

  async paneExists(paneId: string): Promise<boolean> {
    if (this.paneExistsImpl) return this.paneExistsImpl(paneId);
    return true;
  }

  async prompt(name: string, text: string): Promise<RuntimeAgentState> {
    this.prompts.push({ name, text });
    return { status: this.promptStatus };
  }

  async wait(name: string): Promise<RuntimeAgentState> {
    return this.get(name);
  }

  async get(_name: string): Promise<RuntimeAgentState> {
    return { status: this.getStatus };
  }

  async read(_name: string, _lines: number): Promise<string> {
    return "agent output";
  }

  async interrupt(_name: string): Promise<void> {}
  async focus(_name: string): Promise<void> {}
  async reportMetadata(_metadata: AgentMetadata): Promise<void> {}
}

function scout(): AgentDefinition {
  return {
    name: "scout",
    description: "Fast reconnaissance",
    tools: ["read", "bash"],
    systemPrompt: "You are scout.",
    source: "bundled",
    filePath: "/tmp/scout.md",
    thinking: "medium",
    worktree: false,
    interactive: false,
    spawning: false,
  };
}

function config(overrides: Partial<FleetConfig> = {}): FleetConfig {
  return {
    runtime: "herdr",
    maxConcurrent: 6,
    maxDepth: 2,
    notifyOnComplete: true,
    recentReadLines: 80,
    roles: {},
    ...overrides,
  };
}

function fakePi(messages: unknown[]): ExtensionAPI {
  return {
    getThinkingLevel: () => "off",
    sendMessage: (message: unknown) => {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
}

function fakeCtx(): ExtensionContext {
  return { model: undefined } as unknown as ExtensionContext;
}

function interceptSettleTimers(): {
  timers: Array<{ id: number; fn: () => void; cleared: boolean }>;
  restore: () => void;
} {
  const timers: Array<{ id: number; fn: () => void; cleared: boolean }> = [];
  let nextId = 70_000;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((
    fn: TimerHandler,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === 2500 && typeof fn === "function") {
      const id = nextId++;
      timers.push({ id, fn: () => (fn as () => void)(), cleared: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(fn as typeof fn, ms, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    const timer = timers.find((item) => item.id === (id as unknown as number));
    if (timer) {
      timer.cleared = true;
      return;
    }
    realClearTimeout(id);
  }) as typeof clearTimeout;
  return {
    timers,
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

function makeHarness(overrides: Partial<FleetConfig> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-orch-"));
  const registry = new RunRegistry(path.join(dir, "runs.jsonl"), "fleet-test");
  const runtime = new FakeRuntime();
  const messages: unknown[] = [];
  const orch = new Orchestrator(
    fakePi(messages),
    runtime,
    dir,
    config(overrides),
    [scout()],
    registry,
    "fleet-test",
    0,
    () => {},
  );
  return { orch, runtime, registry, messages, dir };
}

const previousSocket = process.env.HERDR_SOCKET_PATH;

afterEach(() => {
  if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
  else process.env.HERDR_SOCKET_PATH = previousSocket;
});

describe("orchestrator lifecycle", () => {
  test("records pre-visual idle as working after prompt submission", async () => {
    const { orch, runtime } = makeHarness();
    runtime.promptStatus = "idle";
    const run = await orch.spawn(
      { role: "scout", task: "inspect auth" },
      fakeCtx(),
    );
    expect(runtime.prompts).toEqual([
      { name: run.herdrName, text: "inspect auth" },
    ]);
    expect(run.state).toBe("working");
  });

  test("passes the multiline fleet prompt as a file, then deletes it", async () => {
    const { orch, runtime } = makeHarness();
    let promptFile = "";
    let promptText = "";
    runtime.startImpl = async (name, paneId, agentArgs) => {
      const flag = agentArgs.indexOf("--append-system-prompt");
      expect(flag).toBeGreaterThanOrEqual(0);
      promptFile = agentArgs[flag + 1] ?? "";
      promptText = fs.readFileSync(promptFile, "utf8");
      return { status: "idle" };
    };
    await orch.spawn({ role: "scout", task: "map modules" }, fakeCtx());
    expect(promptText).toContain("## Fleet coordination");
    expect(promptText).toContain("\n");
    expect(promptFile).toContain("pi-herdr-fleet-prompt-");
    // Cleanup is fire-and-forget after start returns; wait for the unlink.
    const deadline = Date.now() + 500;
    while (fs.existsSync(promptFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(promptFile)).toBe(false);
  });

  test("closes the pane when agent start fails", async () => {
    const { orch, runtime, registry } = makeHarness();
    runtime.startImpl = async () => {
      throw new Error("not an available shell");
    };
    await expect(
      orch.spawn({ role: "scout", task: "x" }, fakeCtx()),
    ).rejects.toThrow(/not an available shell/);
    expect(runtime.closed).toEqual(["w1:p1"]);
    expect(registry.all()[0]?.state).toBe("failed");
    expect(runtime.prompts).toHaveLength(0);
  });

  test("does not submit a task when startup is blocked", async () => {
    const { orch, runtime } = makeHarness();
    runtime.startImpl = async () => {
      throw new HerdrCommandError("blocked UI", "agent_not_ready");
    };
    runtime.getStatus = "blocked";
    const run = await orch.spawn({ role: "scout", task: "secret task" }, fakeCtx());
    expect(run.state).toBe("blocked");
    expect(runtime.closed).toHaveLength(0);
    expect(runtime.prompts).toHaveLength(0);
    expect(run.lastError).toMatch(/not ready for prompts/);
  });

  test("serializes spawn checks so parallel calls cannot exceed maxConcurrent", async () => {
    const { orch, runtime } = makeHarness({ maxConcurrent: 1 });
    runtime.createLocationDelayMs = 40;
    const results = await Promise.allSettled([
      orch.spawn({ role: "scout", task: "one" }, fakeCtx()),
      orch.spawn({ role: "scout", task: "two" }, fakeCtx()),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /concurrency limit/,
    );
  });

  test("counts a submitted working run against the concurrency budget", async () => {
    const { orch } = makeHarness({ maxConcurrent: 1 });
    await orch.spawn({ role: "scout", task: "one" }, fakeCtx());
    await expect(
      orch.spawn({ role: "scout", task: "two" }, fakeCtx()),
    ).rejects.toThrow(/concurrency limit/);
  });

  test("clears the previous settle timer and ignores its generation after a follow-up send", async () => {
    const intercept = interceptSettleTimers();
    try {
      const { orch, runtime, messages } = makeHarness();
      runtime.promptStatus = "idle";
      runtime.getStatus = "idle";
      const run = await orch.spawn({ role: "scout", task: "first" }, fakeCtx());
      expect(intercept.timers).toHaveLength(1);
      const first = intercept.timers[0];
      await orch.send(run.id, "second");
      expect(first?.cleared).toBe(true);
      expect(intercept.timers.filter((t) => !t.cleared)).toHaveLength(1);

      first?.fn();
      await Promise.resolve();
      await Promise.resolve();
      expect(messages).toHaveLength(0);
      expect(orch.list()[0]?.state).toBe("working");
    } finally {
      intercept.restore();
    }
  });

  test("marks stale live runs stopped when their pane is already gone", async () => {
    const { orch, runtime, registry } = makeHarness();
    const stale: AgentRun = {
      id: "deadbeef",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-dead",
      paneId: "w1:gone",
      cwd: "/tmp/repo",
      state: "working",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: Date.now() - 20_000,
      updatedAt: Date.now() - 20_000,
    };
    registry.upsert(stale);
    runtime.paneExistsImpl = async (paneId) => paneId !== "w1:gone";
    delete process.env.HERDR_SOCKET_PATH;
    await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);
    expect(registry.byPane("w1:gone")?.state).toBe("stopped");
  });

  test("does not prune a freshly spawned pane that is briefly invisible", async () => {
    const { orch, runtime, registry } = makeHarness();
    registry.upsert({
      id: "newborn01",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-new",
      paneId: "w1:new",
      cwd: "/tmp/repo",
      state: "starting",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
    });
    runtime.paneExistsImpl = async () => false;
    delete process.env.HERDR_SOCKET_PATH;
    await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);
    expect(registry.byPane("w1:new")?.state).toBe("starting");
  });

  test(
    "trailing-edge syncEvents subscribes to a pane added mid-sync",
    async () => {
      const { orch, registry } = makeHarness();
      registry.upsert({
        id: "pane-a",
        name: "Scout",
        role: "scout",
        herdrName: "fleet-scout-a",
        paneId: "w1:a",
        cwd: "/tmp/repo",
        state: "working",
        depth: 1,
        interactive: false,
        worktree: false,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
      delete process.env.HERDR_SOCKET_PATH;
      await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);

      const seen: string[][] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let enteredFirst = false;
      const original = HerdrEventSubscriber.prototype.ensurePanes;
      HerdrEventSubscriber.prototype.ensurePanes = async function (paneIds) {
        const list = [...paneIds];
        seen.push(list);
        if (seen.length === 1) {
          enteredFirst = true;
          await firstGate;
        }
      };
      try {
        const first = orch.syncEvents();
        const deadline = Date.now() + 1_000;
        while (!enteredFirst && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(enteredFirst).toBe(true);
        expect(seen[0]).toEqual(["w1:a"]);

        registry.upsert({
          id: "pane-b",
          name: "Scout",
          role: "scout",
          herdrName: "fleet-scout-b",
          paneId: "w1:b",
          cwd: "/tmp/repo",
          state: "working",
          depth: 1,
          interactive: false,
          worktree: false,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        });
        const second = orch.syncEvents();
        releaseFirst();
        await Promise.all([first, second]);

        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(seen.some((list) => list.includes("w1:b"))).toBe(true);
        expect(seen.at(-1)?.slice().sort()).toEqual(["w1:a", "w1:b"]);
      } finally {
        HerdrEventSubscriber.prototype.ensurePanes = original;
      }
    },
    3_000,
  );

  test("surfaces agent_blocked without keeping an in-flight turn", async () => {
    const { orch, runtime } = makeHarness();
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    runtime.prompt = async () => {
      throw new HerdrCommandError("needs approval", "agent_blocked");
    };
    const blocked = await orch.send(run.id, "answer the dialog");
    expect(blocked.state).toBe("blocked");
    expect(runtime.closed).toHaveLength(0);
  });
});
