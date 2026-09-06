import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findAgent } from "./agents.js";
import { HerdrCommandError } from "./herdr.js";
import { HerdrEventSubscriber, type HerdrSocketEvent } from "./herdr-events.js";
import { makeHerdrName, makeId, RunRegistry } from "./registry.js";
import type { AgentRuntime } from "./runtime.js";
import type { AgentDefinition, AgentRun, AgentState, FleetConfig, SpawnRequest, ThinkingLevel } from "./types.js";

interface PendingTurn {
  notify: boolean;
  armed: boolean;
  blockedNotified?: boolean;
  generation: number;
}

function withThinking(model: string, thinking?: ThinkingLevel): string {
  if (!thinking) return model;
  if (/:(off|minimal|low|medium|high|xhigh|max)$/.test(model)) return model;
  return `${model}:${thinking}`;
}

function modelFromContext(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model?.provider || !model?.id || model.provider === "unknown") return undefined;
  return `${model.provider}/${model.id}`;
}

function ensureFleetTools(tools: string[] | undefined, canSpawn: boolean): string[] | undefined {
  if (!tools) return undefined;
  const set = new Set(tools);
  for (const name of ["agent_send", "agent_wait", "agent_read", "agent_list", "agent_interrupt", "agent_focus"]) {
    set.add(name);
  }
  if (canSpawn) set.add("agent_spawn");
  return [...set];
}

function isCompleted(state: AgentState): boolean {
  return state === "idle" || state === "done";
}

function isLive(run: AgentRun): boolean {
  return run.state !== "stopped" && run.state !== "failed";
}

function shortModel(model?: string): string {
  if (!model) return "inherit";
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

export class Orchestrator {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly generations = new Map<string, number>();
  private readonly reconcileLocks = new Map<string, Promise<void>>();
  private eventsStarted = false;
  private eventState: "connecting" | "connected" | "reconnecting" | "stopped" = "stopped";
  private readonly events: HerdrEventSubscriber;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly runtime: AgentRuntime,
    private readonly cwd: string,
    private readonly config: FleetConfig,
    private readonly agents: AgentDefinition[],
    private readonly registry: RunRegistry,
    private readonly group: string,
    private readonly depth: number,
    private readonly onChanged: () => void,
  ) {
    this.events = new HerdrEventSubscriber(
      (event) => this.handleSocketEvent(event),
      async () => {
        this.eventState = "connected";
        this.onChanged();
        await this.reconcileAll();
      },
      () => {
        this.eventState = "reconnecting";
        this.onChanged();
      },
    );
  }

  list(): AgentRun[] {
    return this.registry.all();
  }

  socketStatus(): "connecting" | "connected" | "reconnecting" | "stopped" {
    return this.eventState;
  }

  async startEvents(): Promise<void> {
    // Mark the subscriber as part of this session before the first connection
    // attempt. A transient socket failure should not disable later pane-set
    // synchronization; HerdrEventSubscriber owns reconnect/backoff.
    this.eventsStarted = true;
    this.eventState = "connecting";
    this.onChanged();
    await this.events.ensurePanes(this.list().filter(isLive).map((run) => run.paneId));
    await this.events.start();
  }

  stopEvents(): void {
    this.eventsStarted = false;
    this.eventState = "stopped";
    this.events.stop();
    this.onChanged();
  }

  async syncEvents(): Promise<void> {
    if (!this.eventsStarted) return;
    await this.events.ensurePanes(this.list().filter(isLive).map((run) => run.paneId));
  }

  async spawn(request: SpawnRequest, ctx: ExtensionContext): Promise<AgentRun> {
    if (this.depth >= this.config.maxDepth) {
      throw new Error(`Agent nesting limit reached: depth=${this.depth}, maxDepth=${this.config.maxDepth}`);
    }

    const active = this.registry.all().filter((r) => r.state === "starting" || r.state === "working");
    if (active.length >= this.config.maxConcurrent) {
      throw new Error(`Agent concurrency limit reached: ${active.length}/${this.config.maxConcurrent}`);
    }

    const definition = findAgent(this.agents, request.role);
    if (!definition) {
      throw new Error(`Unknown agent role: ${request.role}. Available: ${this.agents.map((a) => a.name).join(", ")}`);
    }

    const override = this.config.roles[definition.name] ?? this.config.roles[request.role] ?? {};
    const model = request.model ?? override.model ?? definition.model ?? this.config.defaultModel ?? modelFromContext(ctx);
    const thinking =
      request.thinking ??
      override.thinking ??
      definition.thinking ??
      this.config.defaultThinking ??
      this.pi.getThinkingLevel();
    const worktree = request.worktree ?? override.worktree ?? definition.worktree ?? false;
    const interactive = request.interactive ?? override.interactive ?? definition.interactive ?? false;
    const canSpawn = (override.spawning ?? definition.spawning ?? false) && this.depth + 1 < this.config.maxDepth;
    const requestedCwd = path.resolve(request.cwd ?? this.cwd);
    const id = makeId();
    const herdrName = makeHerdrName(this.group, definition.name, id);
    const displayName = request.name?.trim() || definition.name;
    const branch = worktree ? `agents/${definition.name}-${id}` : undefined;
    const fleetEnv = {
      PI_HERDR_FLEET_GROUP: this.group,
      PI_HERDR_FLEET_DEPTH: String(this.depth + 1),
      PI_HERDR_FLEET_REGISTRY: this.registry.filePath,
    };

    const location = await this.runtime.createLocation({
      cwd: requestedCwd,
      label: displayName,
      worktree,
      branch,
      direction: request.direction,
      env: fleetEnv,
    });

    const tools = ensureFleetTools(definition.tools, canSpawn);
    const systemPrompt = [
      definition.systemPrompt,
      "",
      "## Fleet coordination",
      `You are '${displayName}' in fleet '${this.group}'.`,
      "Herdr owns terminal topology and lifecycle; use the fleet tools for agent coordination rather than raw terminal injection.",
      "Use agent_send for direct peer-to-peer coordination when another agent has relevant context.",
      "Use agent_list before addressing a peer by role when multiple peers may exist.",
      "If a peer is blocked, inspect its output and escalate the approval/question to the human; never answer a blocked prompt automatically.",
      "Treat Herdr 'unknown' as uncertainty, not completion.",
      "At the end of each delegated turn, finish with a compact HANDOFF section containing outcome, changed files, verification, and unresolved questions.",
      canSpawn ? "You may spawn a child agent when decomposition materially improves the result." : "Do not spawn child agents from this session.",
    ].join("\n");

    const piArgs: string[] = [];
    if (model) piArgs.push("--model", withThinking(model, thinking));
    if (tools?.length) piArgs.push("--tools", tools.join(","));
    if (!canSpawn) piArgs.push("--exclude-tools", "agent_spawn");
    piArgs.push("--append-system-prompt", systemPrompt);
    piArgs.push("--name", `fleet:${displayName}`);

    const now = Date.now();
    const run: AgentRun = {
      id,
      name: displayName,
      role: definition.name,
      herdrName,
      paneId: location.paneId,
      workspaceId: location.workspaceId,
      cwd: location.cwd,
      model,
      thinking,
      state: "starting",
      depth: this.depth + 1,
      interactive,
      worktree,
      startedAt: now,
      updatedAt: now,
    };
    this.save(run);

    try {
      const started = await this.runtime.start(herdrName, location.paneId, piArgs);
      run.state = started.status;
    } catch (error) {
      if (error instanceof HerdrCommandError && error.codeName === "agent_not_ready") {
        // Herdr keeps the live agent name when startup reaches a blocked UI.
        // Do not inject the delegated task through that approval/question.
        const current = await this.runtime.get(herdrName).catch(() => ({ status: "unknown" as const }));
        run.state = current.status;
        run.lastError = "Agent started but is not ready for prompts; delegated task has not been submitted.";
      } else {
        run.state = "failed";
        run.lastError = error instanceof Error ? error.message : String(error);
        run.updatedAt = Date.now();
        this.save(run);
        throw error;
      }
    }
    run.updatedAt = Date.now();
    this.save(run);

    await this.runtime
      .reportMetadata({
        paneId: run.paneId,
        title: displayName,
        displayAgent: `${run.role}: ${displayName}`,
        tokens: {
          fleet: this.group.replace(/^fleet-/, ""),
          role: run.role,
          model: shortModel(run.model),
        },
      })
      .catch(() => undefined);

    await this.syncEvents();
    if (run.state === "blocked" || run.state === "unknown") {
      // Startup did not reach a safe ready state. The task remains intentionally
      // unsent; caller can focus/read the pane, resolve it, then agent_send.
      return run;
    }
    void this.submit(run, request.task, !run.interactive);
    return run;
  }

  async send(target: string, message: string): Promise<AgentRun> {
    const run = this.mustResolve(target);
    await this.syncEvents();
    return this.submit(run, message, true);
  }

  async wait(target: string, timeoutMs?: number): Promise<AgentRun> {
    const run = this.mustResolve(target);
    const state = await this.runtime.wait(run.herdrName, timeoutMs);
    this.updateState(run, state.status);
    const pending = this.pending.get(run.id);
    if (pending?.armed && run.state === "blocked") await this.notifyBlocked(run, pending);
    else if (pending?.armed && isCompleted(run.state)) await this.finalize(run, pending);
    return run;
  }

  async read(target: string, lines = this.config.recentReadLines): Promise<string> {
    const run = this.mustResolve(target);
    return this.runtime.read(run.herdrName, lines);
  }

  async interrupt(target: string): Promise<AgentRun> {
    const run = this.mustResolve(target);
    await this.runtime.interrupt(run.herdrName);
    const current = await this.runtime.get(run.herdrName).catch(() => ({ status: "unknown" as const }));
    this.updateState(run, current.status);
    return run;
  }

  async focus(target: string): Promise<AgentRun> {
    const run = this.mustResolve(target);
    await this.runtime.focus(run.herdrName);
    return run;
  }

  private mustResolve(target: string): AgentRun {
    const run = this.registry.resolve(target);
    if (!run) throw new Error(`Unknown fleet agent: ${target}`);
    return run;
  }

  private async submit(run: AgentRun, text: string, notify: boolean): Promise<AgentRun> {
    const generation = (this.generations.get(run.id) ?? 0) + 1;
    this.generations.set(run.id, generation);
    const pending: PendingTurn = { notify, armed: false, generation };
    this.pending.set(run.id, pending);

    try {
      // The socket subscription is established before submission. The prompt
      // itself intentionally does not use --wait; settlement is pushed by Herdr.
      await this.events.ensurePanes(this.list().filter(isLive).map((item) => item.paneId));
      const submitted = await this.runtime.prompt(run.herdrName, text);
      this.updateState(run, submitted.status);
      pending.armed = true;

      // Reconcile once after prompt acknowledgement to close the tiny race where
      // a very fast turn settles before the socket event reaches this process.
      await this.reconcileRun(run);
      return run;
    } catch (error) {
      if (error instanceof HerdrCommandError && error.codeName === "agent_blocked") {
        // Herdr rejected the prompt before sending input. Do not retain this as
        // an in-flight turn; surface the blocker and let the caller retry after
        // the human resolves it.
        this.pending.delete(run.id);
        this.updateState(run, "blocked");
        run.lastOutput = await this.runtime.read(run.herdrName, this.config.recentReadLines).catch(() => undefined);
        run.updatedAt = Date.now();
        this.save(run);
        return run;
      }
      this.pending.delete(run.id);
      run.state = "failed";
      run.lastError = error instanceof Error ? error.message : String(error);
      run.updatedAt = Date.now();
      this.save(run);
      if (notify && this.config.notifyOnComplete) await this.notifyFailure(run);
      return run;
    }
  }

  private async handleSocketEvent(event: HerdrSocketEvent): Promise<void> {
    const paneId = typeof event.data.pane_id === "string" ? event.data.pane_id : undefined;
    if (event.event === "pane.moved") {
      const previous = typeof event.data.previous_pane_id === "string" ? event.data.previous_pane_id : paneId;
      const pane = event.data.pane;
      const next =
        pane && typeof pane === "object" && !Array.isArray(pane) && typeof (pane as Record<string, unknown>).pane_id === "string"
          ? String((pane as Record<string, unknown>).pane_id)
          : paneId;
      if (previous && next && previous !== next) {
        const run = this.registry.byPane(previous);
        if (run) {
          run.paneId = next;
          run.updatedAt = Date.now();
          this.save(run);
          await this.syncEvents();
        }
      }
      return;
    }

    if (!paneId) return;
    const run = this.registry.byPane(paneId);
    if (!run) return;

    if (event.event === "pane.exited" || event.event === "pane.closed") {
      run.state = "stopped";
      run.updatedAt = Date.now();
      this.pending.delete(run.id);
      this.save(run);
      await this.syncEvents();
      return;
    }

    if (event.event === "pane.agent_status_changed") {
      await this.reconcileRun(run);
    }
  }

  private async reconcileAll(): Promise<void> {
    for (const run of this.list().filter(isLive)) {
      await this.reconcileRun(run);
    }
  }

  private async reconcileRun(run: AgentRun): Promise<void> {
    const previous = this.reconcileLocks.get(run.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        // Event payloads are wake signals. Query the current Herdr state before
        // acting so retained/replayed socket events cannot regress the fleet.
        const current = await this.runtime.get(run.herdrName);
        this.updateState(run, current.status);
        const pending = this.pending.get(run.id);
        if (pending?.armed && run.state === "blocked") await this.notifyBlocked(run, pending);
        else if (pending?.armed && isCompleted(run.state)) await this.finalize(run, pending);
      } catch (error) {
        if (error instanceof HerdrCommandError && error.codeName === "not_found") {
          run.state = "stopped";
          run.updatedAt = Date.now();
          this.pending.delete(run.id);
          this.save(run);
        }
      }
    });
    this.reconcileLocks.set(run.id, next);
    try {
      await next;
    } finally {
      if (this.reconcileLocks.get(run.id) === next) this.reconcileLocks.delete(run.id);
    }
  }

  private async finalize(run: AgentRun, pending: PendingTurn): Promise<void> {
    if (this.pending.get(run.id)?.generation !== pending.generation) return;
    this.pending.delete(run.id);
    run.lastOutput = await this.runtime.read(run.herdrName, this.config.recentReadLines).catch(() => undefined);
    run.updatedAt = Date.now();
    this.save(run);
    if (!pending.notify || !this.config.notifyOnComplete) return;

    const preview = (run.lastOutput ?? "(no readable output)").slice(-12_000);
    const blockedNote =
      run.state === "blocked"
        ? "\n\nThe agent is blocked on an approval/question. Inspect the output and escalate to the human; do not answer it automatically."
        : "";
    await this.pi.sendMessage(
      {
        customType: "fleet-agent-result",
        content: `Agent ${run.name} (${run.role}) settled as ${run.state}.${blockedNote}\n\n${preview}`,
        display: true,
        details: { run },
      },
      { deliverAs: "followUp" },
    );
  }


  private async notifyBlocked(run: AgentRun, pending?: PendingTurn): Promise<void> {
    if (pending?.blockedNotified) return;
    if (pending) pending.blockedNotified = true;
    run.lastOutput = await this.runtime.read(run.herdrName, this.config.recentReadLines).catch(() => undefined);
    run.updatedAt = Date.now();
    this.save(run);
    const preview = (run.lastOutput ?? "(no readable output)").slice(-12_000);
    await this.pi.sendMessage(
      {
        customType: "fleet-agent-attention",
        content: `Agent ${run.name} (${run.role}) is blocked on an approval/question. Inspect it and ask the human before sending any answer.\n\n${preview}`,
        display: true,
        details: { run },
      },
      { deliverAs: "followUp" },
    );
  }

  private async notifyFailure(run: AgentRun): Promise<void> {
    await this.pi.sendMessage(
      {
        customType: "fleet-agent-result",
        content: `Agent ${run.name} (${run.role}) failed: ${run.lastError ?? "unknown error"}`,
        display: true,
        details: { run },
      },
      { deliverAs: "followUp" },
    );
  }

  private updateState(run: AgentRun, state: AgentState): void {
    const previous = run.state;
    run.state = state;
    if (state === "working" && previous === "blocked") {
      const pending = this.pending.get(run.id);
      if (pending) pending.blockedNotified = false;
    }
    run.updatedAt = Date.now();
    this.save(run);
  }

  private save(run: AgentRun): void {
    this.registry.upsert(run);
    this.onChanged();
  }
}
