import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findAgent } from "./agents.js";
import { abortError, HerdrCommandError, isAbortError } from "./herdr.js";
import { HerdrEventSubscriber, type HerdrSocketEvent } from "./herdr-events.js";
import { makeHerdrName, makeId, type RunRegistry } from "./registry.js";
import type { AgentRuntime } from "./runtime.js";
import {
  requireThinkingLevel,
  type AgentDefinition,
  type AgentRun,
  type AgentState,
  type FleetConfig,
  type SpawnRequest,
  type ThinkingLevel,
} from "./types.js";

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
  if (!model?.provider || !model?.id || model.provider === "unknown")
    return undefined;
  return `${model.provider}/${model.id}`;
}

function ensureFleetTools(
  tools: string[] | undefined,
  canSpawn: boolean,
): string[] | undefined {
  if (!tools) return undefined;
  const set = new Set(tools);
  for (const name of [
    "agent_send",
    "agent_wait",
    "agent_read",
    "agent_list",
    "agent_interrupt",
    "agent_focus",
  ]) {
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

/** Skip prune/reap while a pane may still be appearing or flipping TUI state. */
const MIN_RUN_AGE_MS = 10_000;
const PANE_RECHECK_MS = 300;

function shortModel(model?: string): string {
  if (!model) return "inherit";
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

export class AgentWaitTimeoutError extends Error {
  constructor(
    readonly run: AgentRun,
    readonly timeoutMs: number,
  ) {
    super(
      `Wait timed out after ${timeoutMs}ms; ${run.name} is still ${run.state}.`,
    );
    this.name = "AgentWaitTimeoutError";
  }
}

export class Orchestrator {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly generations = new Map<string, number>();
  private readonly reconcileLocks = new Map<string, Promise<void>>();
  private readonly settleChecks = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private spawnGate: Promise<void> = Promise.resolve();
  private syncInFlight?: Promise<void>;
  private syncQueued = false;
  private eventsStarted = false;
  private eventState: "connecting" | "connected" | "reconnecting" | "stopped" =
    "stopped";
  /** Run ids that must survive reap (e.g. agent_send before pending is armed). */
  private readonly reapHold = new Set<string>();
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
    // Prune runs whose pane is already gone BEFORE building the subscription
    // set: herdr rejects a pane.agent_status_changed subscription for a closed
    // pane with pane_not_found, which would otherwise wedge the subscriber in
    // a reconnect loop and permanently leak concurrency slots.
    await this.pruneOrphanRuns();
    if (this.config.closeOnSettle) await this.reapSettledPanes();
    await this.events.ensurePanes(
      this.list()
        .filter(isLive)
        .map((run) => run.paneId),
    );
    await this.events.start();
  }

  stopEvents(): void {
    this.eventsStarted = false;
    this.syncQueued = false;
    this.eventState = "stopped";
    for (const timer of this.settleChecks.values()) clearTimeout(timer);
    this.settleChecks.clear();
    this.events.stop();
    this.onChanged();
  }

  async syncEvents(): Promise<void> {
    if (!this.eventsStarted) return;
    // Registry writes fire the watcher on every save. An in-flight sync that
    // already snapshotted list() would otherwise drop panes a child process
    // just appended; mark dirty and loop so the coalesced callers wait for
    // the trailing prune + ensurePanes.
    if (this.syncInFlight) {
      this.syncQueued = true;
      return this.syncInFlight;
    }
    // Store the raw run promise — not a .finally() wrapper. Chaining
    // `syncInFlight.then(() => this.syncEvents())` onto a finally-wrapped
    // promise turns into a microtask loop: finally clears the slot, the
    // then starts another sync, and tests hang.
    const run = (async () => {
      do {
        this.syncQueued = false;
        if (!this.eventsStarted) break;
        await this.pruneOrphanRuns();
        if (this.config.closeOnSettle) await this.reapSettledPanes();
        await this.events.ensurePanes(
          this.list()
            .filter(isLive)
            .map((item) => item.paneId),
        );
      } while (this.syncQueued);
    })();
    this.syncInFlight = run;
    void run.finally(() => {
      if (this.syncInFlight === run) this.syncInFlight = undefined;
    });
    return run;
  }

  /**
   * Runs whose pane has disappeared can never settle: herdr will not accept
   * subscriptions for their closed panes and the concurrency budget still
   * counts them as active. Mark them stopped before they poison the pane set.
   * A freshly split pane can be invisible to `herdr pane get` for a moment,
   * so young runs and a not-found result are both re-checked before pruning.
   */
  private async pruneOrphanRuns(): Promise<void> {
    for (const run of this.list().filter(isLive)) {
      if (Date.now() - run.startedAt < MIN_RUN_AGE_MS) continue;
      if (!(await this.paneGone(run.paneId))) continue;
      await new Promise((resolve) => setTimeout(resolve, PANE_RECHECK_MS));
      if (!(await this.paneGone(run.paneId))) continue;
      run.state = "stopped";
      run.updatedAt = Date.now();
      this.dropPending(run.id);
      this.save(run);
    }
  }

  /**
   * Non-interactive idle/done panes occupy Herdr layout after the turn has
   * settled and no follow-up is pending. Close them the same way we prune
   * orphans: never young runs, never interactive/blocked/in-flight, and
   * re-query Herdr before destroying the pane.
   */
  private async reapSettledPanes(): Promise<void> {
    for (const run of this.list()) {
      if (!this.isReapCandidate(run)) continue;
      const first = await this.settledStatus(run);
      if (!first || !isCompleted(first)) continue;
      await new Promise((resolve) => setTimeout(resolve, PANE_RECHECK_MS));
      if (!this.isReapCandidate(run)) continue;
      const second = await this.settledStatus(run);
      if (!second || !isCompleted(second)) continue;
      if (await this.closeSettledPane(run)) continue;
    }
  }

  /**
   * User-requested bulk close of Herdr `done` panes. Skips interactive,
   * blocked, in-flight, and panes that Herdr no longer reports as done.
   * Age gates do not apply: `/fleet close` is explicit.
   */
  async closeDonePanes(): Promise<AgentRun[]> {
    const closed: AgentRun[] = [];
    for (const run of this.list()) {
      if (!this.isDoneCloseCandidate(run)) continue;
      const live = await this.settledStatus(run);
      if (live !== "done") continue;
      if (await this.closeSettledPane(run)) closed.push(run);
    }
    return closed;
  }

  private isDoneCloseCandidate(run: AgentRun): boolean {
    if (run.interactive) return false;
    if (run.state !== "done") return false;
    if (this.pending.has(run.id)) return false;
    if (this.reapHold.has(run.id)) return false;
    return true;
  }

  private async closeOnSettleIfNeeded(run: AgentRun): Promise<void> {
    if (!this.config.closeOnSettle) return;
    if (run.interactive) return;
    if (!isCompleted(run.state)) return;
    if (this.pending.has(run.id) || this.reapHold.has(run.id)) return;
    const live = await this.settledStatus(run);
    if (!live || !isCompleted(live)) return;
    await this.closeSettledPane(run);
  }

  private async closeSettledPane(run: AgentRun): Promise<boolean> {
    try {
      await this.runtime.closePane(run.paneId);
    } catch {
      return false;
    }
    run.state = "stopped";
    run.updatedAt = Date.now();
    this.dropPending(run.id);
    this.save(run);
    return true;
  }

  private isReapCandidate(run: AgentRun): boolean {
    if (run.interactive) return false;
    if (!isCompleted(run.state)) return false;
    if (this.pending.has(run.id)) return false;
    if (this.reapHold.has(run.id)) return false;
    const now = Date.now();
    if (now - run.startedAt < MIN_RUN_AGE_MS) return false;
    if (now - run.updatedAt < MIN_RUN_AGE_MS) return false;
    return true;
  }

  private async settledStatus(run: AgentRun): Promise<AgentState | undefined> {
    try {
      const current = await this.runtime.get(run.herdrName);
      if (current.status === run.state) return current.status;
      if (isCompleted(current.status)) {
        // idle↔done is still settled. Do not bump updatedAt or the age gate
        // would postpone (and, if no later sync arrives, skip) the reap.
        run.state = current.status;
        return current.status;
      }
      this.updateState(run, current.status);
      return current.status;
    } catch {
      // Unknown failures must not destroy a pane that may still be useful.
      return undefined;
    }
  }

  private async paneGone(paneId: string): Promise<boolean> {
    try {
      return !(await this.runtime.paneExists(paneId));
    } catch {
      return false; // Unknown failures must not destroy live runs.
    }
  }

  async spawn(
    request: SpawnRequest,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AgentRun> {
    if (this.depth >= this.config.maxDepth) {
      throw new Error(
        `Agent nesting limit reached: depth=${this.depth}, maxDepth=${this.config.maxDepth}`,
      );
    }

    const definition = findAgent(this.agents, request.role);
    if (!definition) {
      throw new Error(
        `Unknown agent role: ${request.role}. Available: ${this.agents.map((a) => a.name).join(", ")}`,
      );
    }

    const override =
      this.config.roles[definition.name] ??
      this.config.roles[request.role] ??
      {};
    const model =
      request.model ??
      override.model ??
      definition.model ??
      this.config.defaultModel ??
      modelFromContext(ctx);
    const thinking = requireThinkingLevel(
      request.thinking !== undefined
        ? request.thinking
        : (override.thinking ??
          definition.thinking ??
          this.config.defaultThinking ??
          this.pi.getThinkingLevel()),
    );
    const worktree =
      request.worktree ?? override.worktree ?? definition.worktree ?? false;
    const interactive =
      request.interactive ??
      override.interactive ??
      definition.interactive ??
      false;
    // Child may spawn only if the role sets spawning: true AND the child's
    // depth (parent+1) is still below maxDepth. Root is depth 0; bundled
    // roles default spawning to false, so only the root session can spawn
    // unless a role override turns it on.
    const canSpawn =
      (override.spawning ?? definition.spawning ?? false) &&
      this.depth + 1 < this.config.maxDepth;
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
      canSpawn
        ? "You may spawn a child agent when decomposition materially improves the result."
        : "Do not spawn child agents from this session.",
    ].join("\n");

    const piArgs: string[] = [];
    if (model) piArgs.push("--model", withThinking(model, thinking));
    if (tools?.length) piArgs.push("--tools", tools.join(","));
    if (!canSpawn) piArgs.push("--exclude-tools", "agent_spawn");
    piArgs.push("--name", `fleet:${displayName}`);

    // The concurrency budget counts runs from the shared registry, so the
    // check-to-first-save window must be atomic: parallel agent_spawn calls
    // would otherwise all observe an empty budget and overshoot the limit.
    const previousGate = this.spawnGate;
    let releaseGate!: () => void;
    this.spawnGate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    if (signal?.aborted) throw abortError(signal);
    await previousGate;
    let run: AgentRun | undefined;
    try {
      if (signal?.aborted) throw abortError(signal);
      const active = this.registry
        .all()
        .filter((r) => r.state === "starting" || r.state === "working");
      if (active.length >= this.config.maxConcurrent) {
        throw new Error(
          `Agent concurrency limit reached: ${active.length}/${this.config.maxConcurrent}`,
        );
      }
      const location = await this.runtime.createLocation(
        {
          cwd: requestedCwd,
          label: displayName,
          worktree,
          branch,
          direction: request.direction,
          env: fleetEnv,
        },
        signal,
      );
      const now = Date.now();
      run = {
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
    } finally {
      releaseGate();
    }
    if (!run) throw new Error("Spawn failed before the pane was recorded.");

    // Herdr re-encodes agent arguments through the target shell and rejects
    // multiline argv elements, so the multiline fleet prompt cannot be passed
    // inline. pi reads --append-system-prompt from a file path; hand the prompt
    // over as a file instead.
    const promptFile = path.join(os.tmpdir(), `pi-herdr-fleet-prompt-${id}.md`);
    fs.writeFileSync(promptFile, systemPrompt, {
      encoding: "utf8",
      mode: 0o600,
    });
    piArgs.push("--append-system-prompt", promptFile);

    try {
      try {
        const started = await this.runtime.start(
          herdrName,
          run.paneId,
          piArgs,
          signal,
        );
        run.state = started.status;
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (
          error instanceof HerdrCommandError &&
          error.codeName === "agent_not_ready"
        ) {
          // Herdr keeps the live agent name when startup reaches a blocked UI.
          // Do not inject the delegated task through that approval/question.
          const current = await this.runtime
            .get(herdrName)
            .catch(() => ({ status: "unknown" as const }));
          run.state = current.status;
          run.lastError =
            "Agent started but is not ready for prompts; delegated task has not been submitted.";
        } else {
          run.state = "failed";
          run.lastError = error instanceof Error ? error.message : String(error);
          run.updatedAt = Date.now();
          this.save(run);
          // The agent never started; an empty leftover pane would be an orphan.
          await this.runtime.closePane(run.paneId).catch(() => undefined);
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

      if (signal?.aborted) throw abortError(signal);
      await this.syncEvents();
      if (run.state === "blocked" || run.state === "unknown") {
        // Startup did not reach a safe ready state. The task remains intentionally
        // unsent; caller can focus/read the pane, resolve it, then agent_send.
        return run;
      }
      // Await the submission: the tool contract is "returns after launch and
      // prompt submission", and the concurrency budget counts working runs from
      // the shared registry — a fire-and-forget submit would let the next spawn
      // observe the previous agent as still `starting` and exceed the limit.
      await this.submit(run, request.task, !run.interactive, signal);
      return run;
    } catch (error) {
      if (isAbortError(error)) await this.abandonSpawn(run);
      throw error;
    } finally {
      void fs.promises.rm(promptFile, { force: true }).catch(() => undefined);
    }
  }

  async send(
    target: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<AgentRun> {
    const run = this.mustResolve(target);
    if (signal?.aborted) throw abortError(signal);
    // syncEvents reaps settled panes. Hold this target first so a follow-up
    // send cannot close the pane it is about to prompt.
    this.reapHold.add(run.id);
    try {
      await this.syncEvents();
      if (signal?.aborted) throw abortError(signal);
      return await this.submit(run, message, true, signal);
    } finally {
      this.reapHold.delete(run.id);
    }
  }

  async wait(
    target: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentRun> {
    const run = this.mustResolve(target);
    if (signal?.aborted) throw abortError(signal);
    const timeout = timeoutMs ?? this.config.defaultWaitTimeoutMs;
    try {
      const state = await this.runtime.wait(run.herdrName, timeout, signal);
      this.updateState(run, state.status);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof HerdrCommandError && error.codeName === "timeout") {
        const current = await this.runtime
          .get(run.herdrName)
          .catch(() => ({ status: run.state }));
        this.updateState(run, current.status);
        throw new AgentWaitTimeoutError(run, timeout);
      }
      throw error;
    }
    const pending = this.pending.get(run.id);
    if (pending?.armed && run.state === "blocked")
      await this.notifyBlocked(run, pending);
    else if (pending?.armed && isCompleted(run.state))
      await this.finalize(run, pending);
    return run;
  }

  async read(
    target: string,
    lines = this.config.recentReadLines,
  ): Promise<string> {
    const run = this.mustResolve(target);
    return this.runtime.read(run.herdrName, lines);
  }

  async interrupt(target: string): Promise<AgentRun> {
    const run = this.mustResolve(target);
    await this.runtime.interrupt(run.herdrName);
    const current = await this.runtime
      .get(run.herdrName)
      .catch(() => ({ status: "unknown" as const }));
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

  private async submit(
    run: AgentRun,
    text: string,
    notify: boolean,
    signal?: AbortSignal,
  ): Promise<AgentRun> {
    if (signal?.aborted) throw abortError(signal);
    this.clearSettleCheck(run.id);
    const generation = (this.generations.get(run.id) ?? 0) + 1;
    this.generations.set(run.id, generation);
    const pending: PendingTurn = { notify, armed: false, generation };
    this.pending.set(run.id, pending);

    try {
      // The socket subscription is established before submission. The prompt
      // itself intentionally does not use --wait; settlement is pushed by Herdr.
      await this.events.ensurePanes(
        this.list()
          .filter(isLive)
          .map((item) => item.paneId),
      );
      if (signal?.aborted) throw abortError(signal);
      const submitted = await this.runtime.prompt(run.herdrName, text, signal);
      // Herdr reports the pre-visual state right after a prompt (usually
      // "idle" because the TUI has not flipped yet). A submitted turn IS
      // running: record it as working so concurrency accounting and the fleet
      // widget stay truthful until Herdr reports a real settlement.
      this.updateState(
        run,
        submitted.status === "idle" ||
          submitted.status === "unknown" ||
          submitted.status === "done"
          ? "working"
          : submitted.status,
      );
      pending.armed = true;
      this.clearSettleCheck(run.id);
      if (submitted.status !== "working") {
        // An extremely fast turn can settle while the prompt command is still
        // in flight, or settle before the TUI ever flips to working; in both
        // cases no further status event may arrive and the run would latch as
        // "working" forever. Verify after a short grace period — verifying
        // immediately would mistake pre-visual idle for a settled turn: if the
        // agent already settled, finalize; if it is working, events take over.
        // The timer is keyed by pending.generation so a follow-up agent_send
        // cannot inherit an older grace period and treat pre-visual idle as
        // completion of the new turn.
        const generation = pending.generation;
        const timer = setTimeout(() => {
          this.settleChecks.delete(run.id);
          if (this.pending.get(run.id)?.generation === generation) {
            void this.reconcileRun(run);
          }
        }, 2_500);
        this.settleChecks.set(run.id, timer);
      }
      return run;
    } catch (error) {
      if (isAbortError(error)) {
        this.dropPending(run.id);
        throw error;
      }
      if (
        error instanceof HerdrCommandError &&
        error.codeName === "agent_blocked"
      ) {
        // Herdr rejected the prompt before sending input. Do not retain this as
        // an in-flight turn; surface the blocker and let the caller retry after
        // the human resolves it.
        this.dropPending(run.id);
        this.updateState(run, "blocked");
        run.lastOutput = await this.runtime
          .read(run.herdrName, this.config.recentReadLines)
          .catch(() => undefined);
        run.updatedAt = Date.now();
        this.save(run);
        return run;
      }
      this.dropPending(run.id);
      run.state = "failed";
      run.lastError = error instanceof Error ? error.message : String(error);
      run.updatedAt = Date.now();
      this.save(run);
      if (notify && this.config.notifyOnComplete) await this.notifyFailure(run);
      return run;
    }
  }

  private async handleSocketEvent(event: HerdrSocketEvent): Promise<void> {
    const paneId =
      typeof event.data.pane_id === "string" ? event.data.pane_id : undefined;
    if (event.event === "pane.moved") {
      const previous =
        typeof event.data.previous_pane_id === "string"
          ? event.data.previous_pane_id
          : paneId;
      const pane = event.data.pane;
      const next =
        pane &&
        typeof pane === "object" &&
        !Array.isArray(pane) &&
        typeof (pane as Record<string, unknown>).pane_id === "string"
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
      this.dropPending(run.id);
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
        // Skip the save when nothing changed: redundant registry appends feed
        // the fs.watch loop and amplify the very churn reconciliation handles.
        if (current.status !== run.state) this.updateState(run, current.status);
        const pending = this.pending.get(run.id);
        if (pending?.armed && run.state === "blocked")
          await this.notifyBlocked(run, pending);
        else if (pending?.armed && isCompleted(run.state))
          await this.finalize(run, pending);
      } catch (error) {
        if (
          error instanceof HerdrCommandError &&
          (error.codeName === "not_found" ||
            error.codeName === "agent_not_found")
        ) {
          // A run still in `starting` may be mid-spawn (agent start takes up
          // to 30s); do not kill it on the first not-found observation.
          if (run.state === "starting" && Date.now() - run.startedAt < 30_000) {
            return;
          }
          run.state = "stopped";
          run.updatedAt = Date.now();
          this.dropPending(run.id);
          this.save(run);
        }
      }
    });
    this.reconcileLocks.set(run.id, next);
    try {
      await next;
    } finally {
      if (this.reconcileLocks.get(run.id) === next)
        this.reconcileLocks.delete(run.id);
    }
  }

  private clearSettleCheck(runId: string): void {
    const timer = this.settleChecks.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.settleChecks.delete(runId);
  }

  private dropPending(runId: string): void {
    this.pending.delete(runId);
    this.clearSettleCheck(runId);
  }

  private async abandonSpawn(run: AgentRun): Promise<void> {
    this.dropPending(run.id);
    await this.runtime.closePane(run.paneId).catch(() => undefined);
    run.state = "stopped";
    run.lastError = "Spawn cancelled.";
    run.updatedAt = Date.now();
    this.save(run);
  }

  private async finalize(run: AgentRun, pending: PendingTurn): Promise<void> {
    if (this.pending.get(run.id)?.generation !== pending.generation) return;
    this.dropPending(run.id);
    run.lastOutput = await this.runtime
      .read(run.herdrName, this.config.recentReadLines)
      .catch(() => undefined);
    run.updatedAt = Date.now();
    this.save(run);
    if (pending.notify && this.config.notifyOnComplete) {
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
    await this.closeOnSettleIfNeeded(run);
  }

  private async notifyBlocked(
    run: AgentRun,
    pending?: PendingTurn,
  ): Promise<void> {
    if (pending?.blockedNotified) return;
    if (pending) pending.blockedNotified = true;
    run.lastOutput = await this.runtime
      .read(run.herdrName, this.config.recentReadLines)
      .catch(() => undefined);
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
