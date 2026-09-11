import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  abortableDelay,
  abortError,
  HerdrCommandError,
} from "../src/herdr.js";
import { HerdrEventSubscriber } from "../src/herdr-events.js";
import { Orchestrator, AgentWaitTimeoutError } from "../src/orchestrator.js";
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
  waitCalls: Array<{
    name: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }> = [];
  createLocationDelayMs = 0;
  promptStatus: AgentState = "working";
  getStatus: AgentState = "working";
  startImpl?: AgentRuntime["start"];
  waitImpl?: AgentRuntime["wait"];
  promptImpl?: AgentRuntime["prompt"];
  getImpl?: AgentRuntime["get"];
  paneExistsImpl?: (paneId: string) => Promise<boolean>;
  private locations = 0;

  async createLocation(
    options: CreateLocationOptions,
    signal?: AbortSignal,
  ): Promise<RuntimeLocation> {
    if (this.createLocationDelayMs > 0) {
      await abortableDelay(this.createLocationDelayMs, signal);
    }
    if (signal?.aborted) throw abortError(signal);
    this.locations += 1;
    return { paneId: `w1:p${this.locations}`, cwd: options.cwd };
  }

  async start(
    name: string,
    paneId: string,
    agentArgs: string[],
    signal?: AbortSignal,
  ): Promise<RuntimeAgentState> {
    this.startCalls.push({ name, paneId, agentArgs });
    if (this.startImpl) return this.startImpl(name, paneId, agentArgs, signal);
    if (signal?.aborted) throw abortError(signal);
    return { status: "idle" };
  }

  async closePane(paneId: string): Promise<void> {
    this.closed.push(paneId);
  }

  async paneExists(paneId: string): Promise<boolean> {
    if (this.paneExistsImpl) return this.paneExistsImpl(paneId);
    return true;
  }

  async prompt(
    name: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<RuntimeAgentState> {
    if (this.promptImpl) return this.promptImpl(name, text, signal);
    if (signal?.aborted) throw abortError(signal);
    this.prompts.push({ name, text });
    return { status: this.promptStatus };
  }

  async wait(
    name: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<RuntimeAgentState> {
    this.waitCalls.push({ name, timeoutMs, signal });
    if (this.waitImpl) return this.waitImpl(name, timeoutMs, signal);
    if (signal?.aborted) {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    return this.get(name);
  }

  async get(name: string): Promise<RuntimeAgentState> {
    if (this.getImpl) return this.getImpl(name);
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
    defaultWaitTimeoutMs: 120_000,
    closeOnSettle: true,
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

  test("accepts an explicit valid thinking level on spawn", async () => {
    const { orch, runtime } = makeHarness();
    const run = await orch.spawn(
      {
        role: "scout",
        task: "go",
        thinking: "high",
        model: "provider/fast",
      },
      fakeCtx(),
    );
    expect(run.thinking).toBe("high");
    expect(runtime.startCalls[0]?.agentArgs).toContain("provider/fast:high");
  });

  test("rejects an invalid thinking level before creating a pane", async () => {
    const { orch, runtime } = makeHarness();
    await expect(
      orch.spawn({ role: "scout", task: "go", thinking: "turbo" }, fakeCtx()),
    ).rejects.toThrow(/Invalid thinking level "turbo".*off, minimal, low, medium, high, xhigh, max/);
    expect(runtime.startCalls).toEqual([]);
    expect(runtime.closed).toEqual([]);
    expect(orch.list()).toEqual([]);
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

  test("reaps a stale non-interactive settled pane after the age and recheck gates", async () => {
    const { orch, runtime, registry } = makeHarness();
    const ago = Date.now() - 20_000;
    registry.upsert({
      id: "settled01",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-settled",
      paneId: "w1:old",
      cwd: "/tmp/repo",
      state: "done",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: ago,
      updatedAt: ago,
    });
    runtime.getStatus = "done";
    delete process.env.HERDR_SOCKET_PATH;
    await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);
    expect(runtime.closed).toEqual(["w1:old"]);
    expect(registry.byPane("w1:old")?.state).toBe("stopped");
  });

  test("does not reap a young settled pane", async () => {
    const { orch, runtime, registry } = makeHarness();
    registry.upsert({
      id: "youngdone",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-young",
      paneId: "w1:young",
      cwd: "/tmp/repo",
      state: "done",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
    });
    runtime.getStatus = "done";
    delete process.env.HERDR_SOCKET_PATH;
    await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);
    expect(runtime.closed).toEqual([]);
    expect(registry.byPane("w1:young")?.state).toBe("done");
  });

  test("does not reap interactive, blocked, or still-working panes", async () => {
    const { orch, runtime, registry } = makeHarness();
    const ago = Date.now() - 20_000;
    const base = {
      role: "scout",
      cwd: "/tmp/repo",
      depth: 1,
      worktree: false,
      startedAt: ago,
      updatedAt: ago,
    } as const;
    registry.upsert({
      ...base,
      id: "interactive1",
      name: "Planner",
      herdrName: "fleet-planner-1",
      paneId: "w1:int",
      state: "idle",
      interactive: true,
    });
    registry.upsert({
      ...base,
      id: "blocked001",
      name: "Scout",
      herdrName: "fleet-scout-block",
      paneId: "w1:blk",
      state: "blocked",
      interactive: false,
    });
    registry.upsert({
      ...base,
      id: "working001",
      name: "Worker",
      herdrName: "fleet-worker-1",
      paneId: "w1:wrk",
      state: "working",
      interactive: false,
    });
    runtime.getStatus = "idle";
    delete process.env.HERDR_SOCKET_PATH;
    await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);
    expect(runtime.closed).toEqual([]);
    expect(registry.byPane("w1:int")?.state).toBe("idle");
    expect(registry.byPane("w1:blk")?.state).toBe("blocked");
    expect(registry.byPane("w1:wrk")?.state).toBe("working");
  });

  test("does not reap when Herdr reports the agent started working during the recheck", async () => {
    const { orch, runtime, registry } = makeHarness();
    const ago = Date.now() - 20_000;
    registry.upsert({
      id: "flip00001",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-flip",
      paneId: "w1:flip",
      cwd: "/tmp/repo",
      state: "done",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: ago,
      updatedAt: ago,
    });
    let calls = 0;
    runtime.getImpl = async () => {
      calls += 1;
      return { status: calls === 1 ? "done" : "working" };
    };
    delete process.env.HERDR_SOCKET_PATH;
    await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);
    expect(runtime.closed).toEqual([]);
    expect(registry.byPane("w1:flip")?.state).toBe("working");
  });

  test("does not reap when runtime get() throws", async () => {
    const { orch, runtime, registry } = makeHarness();
    const ago = Date.now() - 20_000;
    registry.upsert({
      id: "getfail01",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-getfail",
      paneId: "w1:fail",
      cwd: "/tmp/repo",
      state: "done",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: ago,
      updatedAt: ago,
    });
    runtime.getImpl = async () => {
      throw new Error("herdr unavailable");
    };
    delete process.env.HERDR_SOCKET_PATH;
    await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);
    expect(runtime.closed).toEqual([]);
    expect(registry.byPane("w1:fail")?.state).toBe("done");
  });

  test("reaps when Herdr reports done for a stale idle pane without bumping the age gate", async () => {
    const { orch, runtime, registry } = makeHarness();
    const ago = Date.now() - 20_000;
    registry.upsert({
      id: "idledone1",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-idledone",
      paneId: "w1:idledone",
      cwd: "/tmp/repo",
      state: "idle",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: ago,
      updatedAt: ago,
    });
    runtime.getStatus = "done";
    delete process.env.HERDR_SOCKET_PATH;
    await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);
    expect(runtime.closed).toEqual(["w1:idledone"]);
    expect(registry.byPane("w1:idledone")?.state).toBe("stopped");
  });

  test("send holds a stale settled pane so follow-up prompt is not reaped first", async () => {
    const { orch, runtime, registry } = makeHarness();
    registry.upsert({
      id: "anchor001",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-anchor",
      paneId: "w1:anchor",
      cwd: "/tmp/repo",
      state: "working",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
    });
    delete process.env.HERDR_SOCKET_PATH;
    await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);

    const ago = Date.now() - 20_000;
    registry.upsert({
      id: "follow001",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-follow",
      paneId: "w1:follow",
      cwd: "/tmp/repo",
      state: "done",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: ago,
      updatedAt: ago,
    });
    registry.upsert({
      id: "otherdone",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-other",
      paneId: "w1:other",
      cwd: "/tmp/repo",
      state: "done",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: ago,
      updatedAt: ago,
    });
    runtime.getStatus = "done";
    runtime.promptStatus = "working";
    const sent = await orch.send("follow001", "next task");
    expect(runtime.closed).toEqual(["w1:other"]);
    expect(runtime.prompts).toEqual([
      { name: "fleet-scout-follow", text: "next task" },
    ]);
    expect(sent.state).toBe("working");
    expect(registry.byPane("w1:follow")?.state).toBe("working");
    expect(registry.byPane("w1:other")?.state).toBe("stopped");
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

  test("wait uses the configured default timeout when timeout_ms is omitted", async () => {
    const { orch, runtime } = makeHarness({
      defaultWaitTimeoutMs: 45_000,
      closeOnSettle: false,
    });
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    runtime.getStatus = "idle";
    const waited = await orch.wait(run.id);
    expect(waited.state).toBe("idle");
    expect(runtime.waitCalls.at(-1)?.timeoutMs).toBe(45_000);
  });

  test("wait passes an explicit timeout through to the runtime", async () => {
    const { orch, runtime } = makeHarness({ closeOnSettle: false });
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    runtime.getStatus = "done";
    await orch.wait(run.id, 3_000);
    expect(runtime.waitCalls.at(-1)?.timeoutMs).toBe(3_000);
  });

  test("wait maps a Herdr timeout to AgentWaitTimeoutError after refreshing state", async () => {
    const { orch, runtime } = makeHarness({ closeOnSettle: false });
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    runtime.waitImpl = async () => {
      throw new HerdrCommandError("deadline exceeded", "timeout");
    };
    runtime.getStatus = "working";
    try {
      await orch.wait(run.id, 1_000);
      throw new Error("expected AgentWaitTimeoutError");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentWaitTimeoutError);
      const timedOut = error as AgentWaitTimeoutError;
      expect(timedOut.timeoutMs).toBe(1_000);
      expect(timedOut.run.state).toBe("working");
    }
  });

  test("wait aborts when the tool AbortSignal fires", async () => {
    const { orch, runtime } = makeHarness({ closeOnSettle: false });
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.waitImpl = async (_name, _timeoutMs, signal) => {
      release();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
      return { status: "idle" };
    };
    const controller = new AbortController();
    const pending = orch.wait(run.id, 30_000, controller.signal);
    await entered;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("spawn aborts during pane creation without leaving a run", async () => {
    const { orch, runtime } = makeHarness();
    runtime.createLocationDelayMs = 5_000;
    const controller = new AbortController();
    const pending = orch.spawn(
      { role: "scout", task: "go" },
      fakeCtx(),
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(orch.list()).toEqual([]);
    expect(runtime.closed).toEqual([]);
  });

  test("spawn aborts during agent start and closes the pane", async () => {
    const { orch, runtime } = makeHarness();
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.startImpl = async (_name, _paneId, _args, signal) => {
      release();
      await abortableDelay(5_000, signal);
      return { status: "idle" };
    };
    const controller = new AbortController();
    const pending = orch.spawn(
      { role: "scout", task: "go" },
      fakeCtx(),
      controller.signal,
    );
    await entered;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.closed).toEqual(["w1:p1"]);
    expect(orch.list()[0]?.state).toBe("stopped");
    expect(orch.list()[0]?.lastError).toMatch(/cancelled/);
  });

  test("send aborts during prompt without closing the existing pane", async () => {
    const { orch, runtime } = makeHarness({ closeOnSettle: false });
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    expect(runtime.closed).toEqual([]);
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.promptImpl = async (_name, _text, signal) => {
      release();
      await abortableDelay(5_000, signal);
      return { status: "working" };
    };
    const controller = new AbortController();
    const pending = orch.send(run.id, "follow up", controller.signal);
    await entered;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.closed).toEqual([]);
    expect(orch.list()[0]?.state).not.toBe("failed");
    runtime.promptImpl = undefined;
    const again = await orch.send(run.id, "retry");
    expect(again.state).toBe("working");
    expect(runtime.prompts.at(-1)).toEqual({
      name: run.herdrName,
      text: "retry",
    });
  });

  test("closeOnSettle closes a non-interactive pane when wait sees settlement", async () => {
    const { orch, runtime } = makeHarness();
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    runtime.getStatus = "idle";
    const waited = await orch.wait(run.id);
    expect(waited.state).toBe("stopped");
    expect(runtime.closed).toEqual([run.paneId]);
  });

  test("closeOnSettle false leaves a settled pane open after wait", async () => {
    const { orch, runtime } = makeHarness({ closeOnSettle: false });
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    runtime.getStatus = "done";
    const waited = await orch.wait(run.id);
    expect(waited.state).toBe("done");
    expect(runtime.closed).toEqual([]);
  });

  test("closeOnSettle false does not reap a stale settled pane", async () => {
    const { orch, runtime, registry } = makeHarness({ closeOnSettle: false });
    const ago = Date.now() - 20_000;
    registry.upsert({
      id: "keepdone1",
      name: "Scout",
      role: "scout",
      herdrName: "fleet-scout-keep",
      paneId: "w1:keep",
      cwd: "/tmp/repo",
      state: "done",
      depth: 1,
      interactive: false,
      worktree: false,
      startedAt: ago,
      updatedAt: ago,
    });
    runtime.getStatus = "done";
    delete process.env.HERDR_SOCKET_PATH;
    await expect(orch.startEvents()).rejects.toThrow(/HERDR_SOCKET_PATH/);
    expect(runtime.closed).toEqual([]);
    expect(registry.byPane("w1:keep")?.state).toBe("done");
  });

  test("closeDonePanes closes done panes and skips idle, blocked, and interactive", async () => {
    const { orch, runtime, registry } = makeHarness({ closeOnSettle: false });
    const ago = Date.now() - 20_000;
    const base = {
      role: "scout",
      cwd: "/tmp/repo",
      depth: 1,
      worktree: false,
      startedAt: ago,
      updatedAt: ago,
    } as const;
    registry.upsert({
      ...base,
      id: "done00001",
      name: "Scout",
      herdrName: "fleet-scout-done",
      paneId: "w1:done",
      state: "done",
      interactive: false,
    });
    registry.upsert({
      ...base,
      id: "idle00001",
      name: "Scout",
      herdrName: "fleet-scout-idle",
      paneId: "w1:idle",
      state: "idle",
      interactive: false,
    });
    registry.upsert({
      ...base,
      id: "block0001",
      name: "Scout",
      herdrName: "fleet-scout-blk2",
      paneId: "w1:blk2",
      state: "blocked",
      interactive: false,
    });
    registry.upsert({
      ...base,
      id: "plandone1",
      name: "Planner",
      role: "planner",
      herdrName: "fleet-planner-done",
      paneId: "w1:pldone",
      state: "done",
      interactive: true,
    });
    runtime.getStatus = "done";
    const closed = await orch.closeDonePanes();
    expect(closed.map((item) => item.paneId)).toEqual(["w1:done"]);
    expect(runtime.closed).toEqual(["w1:done"]);
    expect(registry.byPane("w1:done")?.state).toBe("stopped");
    expect(registry.byPane("w1:idle")?.state).toBe("idle");
    expect(registry.byPane("w1:blk2")?.state).toBe("blocked");
    expect(registry.byPane("w1:pldone")?.state).toBe("done");
  });

  test("wait on a blocked agent notifies and does not close the pane", async () => {
    const { orch, runtime, messages } = makeHarness();
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    runtime.waitImpl = async () => ({ status: "blocked" });
    const waited = await orch.wait(run.id);
    expect(waited.state).toBe("blocked");
    expect(runtime.closed).toEqual([]);
    expect(
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "customType" in message &&
          message.customType === "fleet-agent-attention",
      ),
    ).toBe(true);
  });
});

describe("pre-visual idle after prompt submission", () => {
  test("a status event right after submit does not finalize or close the pane", async () => {
    const { orch, runtime } = makeHarness();
    runtime.promptStatus = "idle";
    runtime.getStatus = "idle";
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    expect(run.state).toBe("working");
    // Herdr emits agent_status_changed while the prompt text is still being
    // pasted; `agent get` still reports the pre-visual idle state.
    await (
      orch as unknown as {
        handleSocketEvent(event: {
          event: string;
          data: Record<string, unknown>;
          receivedAt: number;
        }): Promise<void>;
      }
    ).handleSocketEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: run.paneId },
      receivedAt: Date.now(),
    });
    expect(runtime.closed).toEqual([]);
    expect(orch.list().find((item) => item.id === run.id)?.state).toBe("working");
  });

  test("a settled status after the grace period still finalizes and closes", async () => {
    const { orch, runtime } = makeHarness();
    runtime.promptStatus = "idle";
    runtime.getStatus = "idle";
    const run = await orch.spawn({ role: "scout", task: "go" }, fakeCtx());
    const internals = orch as unknown as {
      pending: Map<string, { submittedAt?: number }>;
      handleSocketEvent(event: {
        event: string;
        data: Record<string, unknown>;
        receivedAt: number;
      }): Promise<void>;
    };
    const pending = internals.pending.get(run.id);
    expect(pending).toBeDefined();
    pending!.submittedAt = Date.now() - 3_000;
    await internals.handleSocketEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: run.paneId },
      receivedAt: Date.now(),
    });
    expect(runtime.closed).toEqual([run.paneId]);
    expect(orch.list().find((item) => item.id === run.id)?.state).toBe("stopped");
  });
});
