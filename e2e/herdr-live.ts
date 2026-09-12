/**
 * Live E2E against a running Herdr server.
 *
 * Drives the real Orchestrator + HerdrRuntime + socket subscription (the same
 * objects the extension wires up) from a script, so behaviour that only shows
 * up with real Herdr event ordering is exercised: prompt injection right after
 * `agent start`, pre-visual idle, event-driven settlement, closeOnSettle, and
 * follow-up sends to a settled agent.
 *
 * Run from a pane inside Herdr (HERDR_ENV / HERDR_PANE_ID / HERDR_SOCKET_PATH
 * are then already set), or export them by hand:
 *
 *   HERDR_ENV=1 HERDR_PANE_ID=wM:p1 \
 *   HERDR_SOCKET_PATH=$HOME/.config/herdr/herdr.sock bun run e2e
 *
 * Each scenario spawns a real Pi agent on PI_HERDR_FLEET_E2E_MODEL (default
 * opencode-go/glm-5.3-flash, thinking low) with a one-line task, so it costs
 * a few small model calls. Panes are split next to HERDR_PANE_ID and closed
 * again on both success and failure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Orchestrator } from "../src/orchestrator.js";
import { HerdrRuntime } from "../src/runtime-herdr.js";
import { RunRegistry } from "../src/registry.js";
import type {
  AgentDefinition,
  AgentRun,
  FleetConfig,
  ThinkingLevel,
} from "../src/types.js";

const MODEL = process.env.PI_HERDR_FLEET_E2E_MODEL ?? "opencode-go/glm-5.3-flash";
const THINKING = (process.env.PI_HERDR_FLEET_E2E_THINKING ?? "low") as ThinkingLevel;
const SETTLE_TIMEOUT_MS = Number(process.env.PI_HERDR_FLEET_E2E_TIMEOUT_MS ?? 180_000);

interface FleetMessage {
  customType?: string;
  content?: string;
  details?: { run?: AgentRun };
}

interface Harness {
  orchestrator: Orchestrator;
  runtime: HerdrRuntime;
  registry: RunRegistry;
  messages: FleetMessage[];
  registryPath: string;
  stop(): Promise<void>;
}

function requireEnv(): void {
  const missing = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"].filter(
    (name) => !process.env[name],
  );
  if (process.env.HERDR_ENV !== "1" || missing.length) {
    console.error(
      [
        "This E2E needs a running Herdr and the pane environment:",
        "  HERDR_ENV=1, HERDR_PANE_ID=<pane to split from>, HERDR_SOCKET_PATH=<herdr.sock>",
        `Missing: ${missing.join(", ") || "HERDR_ENV must be 1"}`,
      ].join("\n"),
    );
    process.exit(2);
  }
}

function makeHarness(overrides: Partial<FleetConfig> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-fleet-e2e-"));
  const group = `fleet-e2e-${path.basename(dir).slice(-6)}`;
  const registryPath = path.join(dir, `${group}.jsonl`);
  const registry = new RunRegistry(registryPath, group);
  const messages: FleetMessage[] = [];
  const pi = {
    getThinkingLevel: () => THINKING,
    sendMessage: (message: FleetMessage) => {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  const config: FleetConfig = {
    runtime: "herdr",
    defaultModel: MODEL,
    defaultThinking: THINKING,
    maxConcurrent: 4,
    maxDepth: 2,
    notifyOnComplete: true,
    recentReadLines: 80,
    defaultWaitTimeoutMs: SETTLE_TIMEOUT_MS,
    closeOnSettle: true,
    roles: {},
    models: {},
    ...overrides,
  };
  const echo: AgentDefinition = {
    name: "echo",
    description: "E2E fixture: answers with exactly what it is told to answer.",
    tools: ["read"],
    systemPrompt:
      "You are an E2E fixture. Reply with exactly the text the task asks for and nothing else. Do not use tools.",
    interactive: false,
    worktree: false,
    spawning: false,
    source: "bundled",
    filePath: "<e2e>",
  };
  const runtime = new HerdrRuntime();
  const orchestrator = new Orchestrator(
    pi,
    runtime,
    process.cwd(),
    config,
    [echo],
    registry,
    group,
    0,
    () => {},
  );
  return {
    orchestrator,
    runtime,
    registry,
    messages,
    registryPath,
    async stop() {
      orchestrator.stopEvents();
      for (const run of orchestrator.list()) {
        if (run.state === "stopped" || run.state === "failed") continue;
        await runtime.closePane(run.paneId).catch(() => undefined);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ctx = { model: undefined } as unknown as ExtensionContext;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  probe: () => T | undefined,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

function resultFor(h: Harness, runId: string, after = 0): FleetMessage | undefined {
  return h.messages
    .slice(after)
    .find((m) => m.customType === "fleet-agent-result" && m.details?.run?.id === runId);
}

/**
 * A completion message for the run, or a failure as soon as the run is gone
 * without one. The pre-visual idle bug looked exactly like that: the pane was
 * closed ~100ms after the prompt, before the agent ever answered.
 */
function completion(h: Harness, run: AgentRun, after = 0): () => FleetMessage | undefined {
  return () => {
    const found = resultFor(h, run.id, after);
    if (found) return found;
    const state = h.registry.byPane(run.paneId)?.state;
    if (state === "stopped" || state === "failed") {
      throw new Error(`run ${run.name} became ${state} before delivering a result`);
    }
    return undefined;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Scenario = { name: string; run: () => Promise<void> };

/**
 * The pre-visual idle bug only surfaced with a long multiline task: pasting
 * it takes long enough for Herdr to emit a status event before the trailing
 * newline, and `agent get` still answered idle at that point. A one-line task
 * goes through too fast to hit the window, so the regression task mirrors the
 * size of a real handoff brief.
 */
function longTask(reply: string): string {
  const filler = Array.from({ length: 40 }, (_, i) =>
    `- Context line ${i + 1}: this paragraph exists only to make the prompt as long as a real delegated brief, including punctuation, \`backticks\`, "quotes" and $(shell-looking) fragments.`,
  );
  return ["## Handoff", ...filler, "", `Ignore everything above. Reply with exactly: ${reply}`].join("\n");
}

const scenarios: Scenario[] = [
  {
    name: "spawn survives prompt injection and settles through Herdr events",
    async run() {
      const h = makeHarness();
      try {
        await h.orchestrator.startEvents();
        const run = await h.orchestrator.spawn(
          { role: "echo", task: longTask("E2E-ALPHA") },
          ctx,
        );
        assert(run.state === "working", `expected working after spawn, got ${run.state}`);
        const result = await waitFor("completion message", completion(h, run));
        assert(/settled as (done|idle)/.test(result.content ?? ""), `unexpected result: ${result.content}`);
        assert((result.details?.run?.lastOutput ?? "").includes("E2E-ALPHA"), "agent output did not contain the requested reply");
        const final = await waitFor("closeOnSettle", () =>
          h.registry.byPane(run.paneId)?.state === "stopped" ? true : undefined,
        );
        assert(final, "run not marked stopped");
        assert(!(await h.runtime.paneExists(run.paneId)), "pane still open after closeOnSettle");
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "follow-up agent_send to a settled agent is delivered, not reaped",
    async run() {
      const h = makeHarness({ closeOnSettle: false });
      try {
        await h.orchestrator.startEvents();
        const run = await h.orchestrator.spawn(
          { role: "echo", task: "Reply with exactly: E2E-PING" },
          ctx,
        );
        const first = await waitFor("first completion", completion(h, run));
        assert((first.details?.run?.lastOutput ?? "").includes("E2E-PING"), "first reply missing");
        const seen = h.messages.length;
        await sleep(1_000);
        await h.orchestrator.send(run.id, "Reply with exactly: E2E-PONG");
        const second = await waitFor("second completion", completion(h, run, seen));
        assert((second.details?.run?.lastOutput ?? "").includes("E2E-PONG"), "follow-up reply missing");
        assert(await h.runtime.paneExists(run.paneId), "pane closed although closeOnSettle is false");
        const closed = await h.orchestrator.closeDonePanes();
        assert(closed.length === 1 || !(await h.runtime.paneExists(run.paneId)), "/fleet close did not close the done pane");
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "an unknown model fails fast and falls back to the configured model",
    async run() {
      const h = makeHarness({
        roles: { echo: { model: "bogus-provider/no-such-model", fallbackModels: [MODEL] } },
      });
      try {
        await h.orchestrator.startEvents();
        const startedAt = Date.now();
        const run = await h.orchestrator.spawn(
          { role: "echo", task: "Reply with exactly: E2E-FALLBACK" },
          ctx,
        );
        const elapsed = Date.now() - startedAt;
        assert(run.model === MODEL, `expected fallback model ${MODEL}, got ${run.model}`);
        assert(run.fallbackFrom === "bogus-provider/no-such-model", "fallbackFrom not recorded");
        assert(elapsed < 20_000, `fallback took ${elapsed}ms; startup failure was not detected early`);
        const note = h.messages.find((m) => m.customType === "fleet-agent-fallback");
        assert(note && /not found/i.test(note.content ?? ""), `fallback notice missing or without reason: ${note?.content}`);
        const failed = h.orchestrator.list().find((r) => r.model === "bogus-provider/no-such-model");
        assert(failed?.state === "failed", "primary attempt not recorded as failed");
        assert(!(await h.runtime.paneExists(failed.paneId)), "failed primary pane was left open");
        const result = await waitFor("completion message", completion(h, run));
        assert((result.details?.run?.lastOutput ?? "").includes("E2E-FALLBACK"), "fallback agent did not answer");
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: "two agents spawned back-to-back both settle",
    async run() {
      const h = makeHarness();
      try {
        await h.orchestrator.startEvents();
        const [a, b] = await Promise.all([
          h.orchestrator.spawn({ role: "echo", name: "left", task: "Reply with exactly: E2E-LEFT" }, ctx),
          h.orchestrator.spawn({ role: "echo", name: "right", task: "Reply with exactly: E2E-RIGHT" }, ctx),
        ]);
        assert(a.paneId !== b.paneId, "both spawns landed in the same pane");
        const ra = await waitFor("left completion", completion(h, a));
        const rb = await waitFor("right completion", completion(h, b));
        assert((ra.details?.run?.lastOutput ?? "").includes("E2E-LEFT"), "left reply missing");
        assert((rb.details?.run?.lastOutput ?? "").includes("E2E-RIGHT"), "right reply missing");
      } finally {
        await h.stop();
      }
    },
  },
];

async function main(): Promise<void> {
  requireEnv();
  const only = process.argv[2];
  let failed = 0;
  console.log(`pi-herdr-fleet live E2E · model ${MODEL}:${THINKING} · split from ${process.env.HERDR_PANE_ID}`);
  for (const scenario of scenarios) {
    if (only && !scenario.name.includes(only)) continue;
    const startedAt = Date.now();
    try {
      await scenario.run();
      console.log(`PASS ${scenario.name} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${scenario.name} (${Date.now() - startedAt}ms)`);
      console.log(`     ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
