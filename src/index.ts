import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.js";
import { loadConfig } from "./config.js";
import { isHerdrAvailable, OUTSIDE_HERDR_WARNING } from "./herdr.js";
import { Orchestrator } from "./orchestrator.js";
import { HerdrRuntime } from "./runtime-herdr.js";
import { makeGroupId, RunRegistry } from "./registry.js";
import type { AgentRun, ThinkingLevel } from "./types.js";

const STATE_ICON: Record<AgentRun["state"], string> = {
  starting: "…",
  working: "●",
  idle: "○",
  done: "✓",
  blocked: "?",
  unknown: "◇",
  failed: "×",
  stopped: "■",
};

function modelLabel(model?: string): string {
  if (!model) return "inherit";
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function notifyWarnings(ctx: ExtensionContext, warnings: string[]): void {
  if (!warnings.length) return;
  ctx.ui.notify(warnings.join("\n"), "warning");
}

function registerOutsideHerdrWarning(pi: ExtensionAPI): void {
  let notified = false;
  pi.on("session_start", (_event, ctx) => {
    if (notified) return;
    notified = true;
    ctx.ui.notify(OUTSIDE_HERDR_WARNING, "warning");
  });
  pi.registerCommand("fleet", {
    description: "Show the current Herdr agent fleet",
    async handler(_args, ctx) {
      ctx.ui.notify(OUTSIDE_HERDR_WARNING, "warning");
    },
  });
}

export default function herdrFleetExtension(pi: ExtensionAPI): void {
  if (!isHerdrAvailable()) {
    registerOutsideHerdrWarning(pi);
    return;
  }

  const cwd = process.cwd();
  const startupWarnings: string[] = [];
  const config = loadConfig(cwd, startupWarnings);
  const agents = discoverAgents(cwd, startupWarnings);
  const group = process.env.PI_HERDR_FLEET_GROUP || makeGroupId();
  const depth =
    Number.parseInt(process.env.PI_HERDR_FLEET_DEPTH || "0", 10) || 0;
  const registryPath =
    process.env.PI_HERDR_FLEET_REGISTRY ||
    path.join(getAgentDir(), "herdr-fleet", `${group}.jsonl`);
  const registry = new RunRegistry(registryPath, group);
  let activeCtx: ExtensionContext | undefined;

  // The per-run prompt temp files are deleted right after the agent starts,
  // but a hard crash between write and cleanup would leak one file per spawn.
  // Spawns never take an hour, so anything older than that is crash residue.
  const sweepStalePromptFiles = (): void => {
    try {
      const cutoff = Date.now() - 3_600_000;
      for (const entry of fs.readdirSync(os.tmpdir())) {
        if (!entry.startsWith("pi-herdr-fleet-prompt-")) continue;
        const full = path.join(os.tmpdir(), entry);
        try {
          if (fs.statSync(full).mtimeMs < cutoff)
            fs.rmSync(full, { force: true });
        } catch {
          // The file may already be gone.
        }
      }
    } catch {
      // tmpdir listing failures are non-fatal.
    }
  };

  const updateWidget = (): void => {
    const ctx = activeCtx;
    if (!ctx?.hasUI) return;
    try {
      const runs = registry.all();
      if (!runs.length) {
        ctx.ui.setWidget("herdr-fleet", undefined);
        return;
      }
      const active = runs.filter(
        (r) => r.state === "starting" || r.state === "working",
      ).length;
      const blocked = runs.filter((r) => r.state === "blocked").length;
      const suffix = blocked ? ` · ${blocked} blocked` : "";
      const socket = orchestrator.socketStatus();
      const socketSuffix = socket === "connected" ? "" : ` · events:${socket}`;
      const lines = [
        `Fleet agents · ${active} active${suffix}${socketSuffix} · depth ${depth}/${config.maxDepth}`,
      ];
      // Active runs always stay visible; settled runs are shown only from the
      // most recent few so a long session cannot push live agents out of the
      // widget or grow the list without bound.
      const live = runs.filter(
        (r) =>
          r.state === "starting" ||
          r.state === "working" ||
          r.state === "blocked",
      );
      const settled = runs.filter((r) => !live.includes(r)).slice(-4);
      for (const run of [...live, ...settled].slice(0, 8)) {
        const thinking = run.thinking ? `:${run.thinking}` : "";
        const wt = run.worktree ? " · wt" : "";
        lines.push(
          `${STATE_ICON[run.state]} ${run.name} (${run.role}) · ${modelLabel(run.model)}${thinking} · ${run.state}${wt}`,
        );
      }
      const overflow = runs.length - live.length - settled.length;
      if (overflow > 0) lines.push(`… ${overflow} more`);
      ctx.ui.setWidget("herdr-fleet", lines);
    } catch {
      // Widget updates are cosmetic. A UI failure must never propagate into
      // socket or registry callbacks, where it would crash the agent process.
    }
  };

  const runtime = new HerdrRuntime();
  const orchestrator = new Orchestrator(
    pi,
    runtime,
    cwd,
    config,
    agents,
    registry,
    group,
    depth,
    updateWidget,
  );

  let registryWatcher: fs.FSWatcher | undefined;
  const onRegistryChanged = (): void => {
    updateWidget();
    void orchestrator.syncEvents();
  };

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    notifyWarnings(ctx, startupWarnings);
    sweepStalePromptFiles();
    registryWatcher?.close();
    registryWatcher = fs.watch(registryPath, onRegistryChanged);
    updateWidget();
    try {
      await orchestrator.startEvents();
    } catch (error) {
      ctx.ui.notify(
        `pi-herdr-fleet: initial Herdr event subscription failed; reconnecting: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", () => {
    registryWatcher?.close();
    registryWatcher = undefined;
    orchestrator.stopEvents();
    activeCtx = undefined;
  });

  pi.on("before_agent_start", (event) => {
    const roles = agents.map((a) => `${a.name}: ${a.description}`).join("; ");
    const guidance = [
      "## Herdr agent fleet",
      `Available roles: ${roles || "none"}`,
      "Use agent_spawn for genuinely independent work, not as a reflex for small tasks.",
      "Default topology is a sibling pane in the current tab/cwd without stealing focus; request a worktree only when isolation is actually wanted.",
      "Use agent_send for peer-to-peer coordination. Use agent_wait only when explicit synchronization is necessary; normal completion is event-driven.",
      "Herdr states are semantic: working is active, blocked needs human attention, done is unseen settled work, idle is seen/ready, and unknown is uncertainty rather than completion.",
      "Never auto-answer a blocked approval/question. Read the agent and surface the question to the human.",
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  pi.registerTool(
    defineTool({
      name: "agent_spawn",
      label: "Spawn Agent",
      description:
        "Spawn an interactive Pi agent in a Herdr-managed sibling pane or explicit worktree. Model/thinking/tools come from the selected role. Returns after launch and prompt submission; lifecycle completion is event-driven.",
      parameters: Type.Object({
        role: Type.String({
          description: "Agent role, e.g. scout, planner, worker, reviewer",
        }),
        task: Type.String({ description: "Task/prompt for the agent" }),
        name: Type.Optional(
          Type.String({ description: "Human-readable display name" }),
        ),
        model: Type.Optional(
          Type.String({
            description: "One-off model override (provider/model)",
          }),
        ),
        thinking: Type.Optional(
          Type.String({ description: "off|minimal|low|medium|high|xhigh|max" }),
        ),
        cwd: Type.Optional(
          Type.String({
            description: "Working directory; defaults to the current project",
          }),
        ),
        worktree: Type.Optional(
          Type.Boolean({
            description:
              "Explicitly isolate this agent in a Herdr Git worktree. Defaults to false unless configured by role.",
          }),
        ),
        direction: Type.Optional(
          Type.String({
            description:
              "Optional sibling split direction: right or down. Otherwise chosen from pane geometry.",
          }),
        ),
        interactive: Type.Optional(
          Type.Boolean({
            description:
              "If true, suppress automatic caller wake-up when this turn settles",
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        activeCtx = ctx;
        const direction =
          params.direction === "right" || params.direction === "down"
            ? params.direction
            : undefined;
        const run = await orchestrator.spawn(
          {
            role: params.role,
            task: params.task,
            name: params.name,
            model: params.model,
            thinking: params.thinking as ThinkingLevel | undefined,
            cwd: params.cwd,
            worktree: params.worktree,
            direction,
            interactive: params.interactive,
          },
          ctx,
        );
        return {
          content: [
            {
              type: "text",
              text:
                run.state === "blocked" || run.state === "unknown"
                  ? `Started ${run.name} [${run.id}] as ${run.herdrName} in ${run.paneId}, but Herdr reports ${run.state}. The delegated task was not submitted; inspect/focus the agent, resolve readiness, then use agent_send.`
                  : `Started ${run.name} [${run.id}] as ${run.herdrName} in ${run.paneId} using ${run.model ?? "inherited/default model"}${run.worktree ? " (worktree)" : ""}.`,
            },
          ],
          details: run,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "agent_send",
      label: "Message Agent",
      description:
        "Send a prompt or steering message directly to a fleet agent by id, display name, role, Herdr name, or pane id. If it is blocked, do not answer the UI automatically; surface the question to the human.",
      parameters: Type.Object({
        target: Type.String(),
        message: Type.String(),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        activeCtx = ctx;
        const run = await orchestrator.send(params.target, params.message);
        return {
          content: [
            {
              type: "text",
              text:
                run.state === "blocked"
                  ? `${run.name} [${run.id}] is blocked; message was not submitted. Inspect the agent and ask the human.`
                  : run.state === "failed"
                    ? `Failed to message ${run.name} [${run.id}]: ${run.lastError ?? "unknown error"}`
                    : `Message submitted to ${run.name} [${run.id}].`,
            },
          ],
          details: run,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "agent_wait",
      label: "Wait Agent",
      description:
        "Synchronize with a fleet agent using Herdr's server-owned semantic wait. Defaults to idle/done/blocked; prefer event-driven completion unless this call must block.",
      parameters: Type.Object({
        target: Type.String(),
        timeout_ms: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        activeCtx = ctx;
        const run = await orchestrator.wait(params.target, params.timeout_ms);
        return {
          content: [{ type: "text", text: `${run.name} is ${run.state}.` }],
          details: run,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "agent_read",
      label: "Read Agent",
      description:
        "Read recent unwrapped terminal output from a fleet agent. Reads do not consume Herdr's done/unseen state.",
      parameters: Type.Object({
        target: Type.String(),
        lines: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        activeCtx = ctx;
        const text = await orchestrator.read(params.target, params.lines);
        return {
          content: [{ type: "text", text: text || "(no output)" }],
          details: { target: params.target },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "agent_interrupt",
      label: "Interrupt Agent",
      description:
        "Send Herdr's logical esc key to interrupt the current turn without destroying the pane/session.",
      parameters: Type.Object({ target: Type.String() }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        activeCtx = ctx;
        const run = await orchestrator.interrupt(params.target);
        return {
          content: [
            {
              type: "text",
              text: `Interrupted ${run.name} [${run.id}]. Current Herdr state: ${run.state}.`,
            },
          ],
          details: run,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "agent_focus",
      label: "Focus Agent",
      description:
        "Focus a fleet agent in Herdr for direct human interaction. This may change done to idle because the work becomes seen.",
      parameters: Type.Object({ target: Type.String() }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        activeCtx = ctx;
        const run = await orchestrator.focus(params.target);
        return {
          content: [
            { type: "text", text: `Focused ${run.name} [${run.id}] in Herdr.` },
          ],
          details: run,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "agent_list",
      label: "List Agents",
      description:
        "List every known agent in the shared fleet, including peers spawned by child agents.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        activeCtx = ctx;
        const runs = orchestrator.list();
        const text = runs.length
          ? runs
              .map(
                (r) =>
                  `${r.id}  ${r.name}  role=${r.role} state=${r.state} model=${r.model ?? "inherit"} pane=${r.paneId}${r.worktree ? " worktree" : ""}`,
              )
              .join("\n")
          : "No fleet agents have been spawned yet.";
        return { content: [{ type: "text", text }], details: { group, runs } };
      },
    }),
  );

  pi.registerCommand("fleet", {
    description: "Show the current Herdr agent fleet",
    async handler(_args, ctx) {
      activeCtx = ctx;
      const runs = orchestrator.list();
      const lines = [
        `group=${group}`,
        `depth=${depth}/${config.maxDepth}`,
        `registry=${registryPath}`,
        `events=${orchestrator.socketStatus()}`,
        `roles=${agents.map((a) => a.name).join(", ") || "none"}`,
        ...runs.map(
          (r) =>
            `${STATE_ICON[r.state]} ${r.id} ${r.name} (${r.role}) ${r.state} ${r.herdrName} ${r.paneId}`,
        ),
      ];
      notifyWarnings(ctx, startupWarnings);
      ctx.ui.notify(lines.join("\n"), "info");
      updateWidget();
    },
  });
}
