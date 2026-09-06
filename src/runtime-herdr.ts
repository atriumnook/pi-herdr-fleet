import {
  assertHerdr,
  HerdrCommandError,
  herdrJson,
  herdrText,
} from "./herdr.js";
import type {
  AgentMetadata,
  AgentRuntime,
  CreateLocationOptions,
  RuntimeAgentState,
  RuntimeLocation,
} from "./runtime.js";
import type { AgentState } from "./types.js";

interface PaneSplitResult {
  pane?: { pane_id?: string };
}

interface WorktreeCreateResult {
  workspace?: { workspace_id?: string; id?: string };
  tab?: { tab_id?: string };
  root_pane?: { pane_id?: string };
  worktree?: { path?: string };
}

interface AgentResult {
  agent?: {
    agent_status?: string;
    status?: string;
    pane_id?: string;
  };
}

interface LayoutResult {
  layout?: unknown;
  area?: unknown;
  panes?: unknown;
}

function toAgentState(status: string | undefined): AgentState {
  switch (status) {
    case "working":
    case "idle":
    case "done":
    case "blocked":
    case "unknown":
      return status;
    default:
      return "unknown";
  }
}

function statusFromResult(result: AgentResult | undefined): RuntimeAgentState {
  const raw = result?.agent?.agent_status ?? result?.agent?.status;
  return { status: toAgentState(raw) };
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function dimensions(
  value: unknown,
): { width: number; height: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const obj = value as Record<string, unknown>;
  const width = numeric(obj.width) ?? numeric(obj.cols) ?? numeric(obj.w);
  const height = numeric(obj.height) ?? numeric(obj.rows) ?? numeric(obj.h);
  if (width !== undefined && height !== undefined && width > 0 && height > 0)
    return { width, height };
  for (const key of ["rect", "area", "bounds"]) {
    const nested = dimensions(obj[key]);
    if (nested) return nested;
  }
  return undefined;
}

function findPaneDimensions(
  value: unknown,
  paneId: string,
): { width: number; height: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPaneDimensions(item, paneId);
      if (found) return found;
    }
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  if (obj.pane_id === paneId) {
    const own = dimensions(obj);
    if (own) return own;
  }
  for (const nested of Object.values(obj)) {
    const found = findPaneDimensions(nested, paneId);
    if (found) return found;
  }
  return undefined;
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`,
  ]);
}

export class HerdrRuntime implements AgentRuntime {
  readonly kind = "herdr" as const;

  constructor() {
    assertHerdr();
  }

  async createLocation(
    options: CreateLocationOptions,
  ): Promise<RuntimeLocation> {
    if (options.worktree) {
      if (!options.branch)
        throw new Error("Herdr worktree runtime requires a branch name.");
      const created = await herdrJson<WorktreeCreateResult>([
        "worktree",
        "create",
        "--cwd",
        options.cwd,
        "--branch",
        options.branch,
        "--label",
        options.label,
        "--no-focus",
      ]);
      const rootPaneId = created.result?.root_pane?.pane_id;
      if (!rootPaneId)
        throw new Error(
          "Herdr worktree create did not return result.root_pane.pane_id.",
        );
      const cwd = created.result?.worktree?.path ?? options.cwd;

      // worktree.create does not expose --env. Create the actual agent pane with
      // pane split --env and remove the temporary empty root pane. This keeps
      // fleet context injection cross-shell and cross-platform.
      const split = await herdrJson<PaneSplitResult>([
        "pane",
        "split",
        rootPaneId,
        "--direction",
        await this.chooseSplitDirection(rootPaneId),
        "--cwd",
        cwd,
        ...envArgs(options.env),
        "--no-focus",
      ]);
      const paneId = split.result?.pane?.pane_id;
      if (!paneId)
        throw new Error(
          "Herdr worktree agent pane split did not return result.pane.pane_id.",
        );
      await herdrJson(["pane", "close", rootPaneId]);
      return {
        paneId,
        workspaceId:
          created.result?.workspace?.workspace_id ??
          created.result?.workspace?.id,
        cwd,
      };
    }

    const callerPane = process.env.HERDR_PANE_ID;
    if (!callerPane)
      throw new Error(
        "HERDR_PANE_ID is required to create a sibling agent pane.",
      );
    const direction =
      options.direction ?? (await this.chooseSplitDirection(callerPane));
    const split = await herdrJson<PaneSplitResult>([
      "pane",
      "split",
      callerPane,
      "--direction",
      direction,
      "--cwd",
      options.cwd,
      ...envArgs(options.env),
      "--no-focus",
    ]);
    const paneId = split.result?.pane?.pane_id;
    if (!paneId)
      throw new Error("Herdr pane split did not return result.pane.pane_id.");
    return { paneId, cwd: options.cwd };
  }

  async start(
    name: string,
    paneId: string,
    agentArgs: string[],
  ): Promise<RuntimeAgentState> {
    const args = [
      "agent",
      "start",
      name,
      "--kind",
      "pi",
      "--pane",
      paneId,
      "--",
      ...agentArgs,
    ];
    let lastError: unknown;
    // A freshly split pane needs a moment to reach its interactive shell
    // prompt, and Herdr rejects `agent start` until then. Retry that
    // transient rejection with a short backoff instead of failing the spawn.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await herdrJson<AgentResult>(args);
        return statusFromResult(result.result);
      } catch (error) {
        lastError = error;
        if (
          error instanceof HerdrCommandError &&
          /not an available shell/i.test(error.message)
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, 300 * (attempt + 1)),
          );
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  async closePane(paneId: string): Promise<void> {
    await herdrJson(["pane", "close", paneId]);
  }

  async paneExists(paneId: string): Promise<boolean> {
    try {
      await herdrJson(["pane", "get", paneId]);
      return true;
    } catch (error) {
      // Unknown failures (transient CLI/server issues) must not destroy live
      // runs; only a definitive pane_not_found means the pane is gone.
      if (
        error instanceof HerdrCommandError &&
        error.codeName === "pane_not_found"
      )
        return false;
      return true;
    }
  }

  async prompt(name: string, text: string): Promise<RuntimeAgentState> {
    const result = await herdrJson<AgentResult>([
      "agent",
      "prompt",
      name,
      text,
    ]);
    return statusFromResult(result.result);
  }

  async wait(name: string, timeoutMs?: number): Promise<RuntimeAgentState> {
    const args = ["agent", "wait", name];
    if (timeoutMs !== undefined) args.push("--timeout", String(timeoutMs));
    const result = await herdrJson<AgentResult>(args);
    return statusFromResult(result.result);
  }

  async get(name: string): Promise<RuntimeAgentState> {
    const result = await herdrJson<AgentResult>(["agent", "get", name]);
    return statusFromResult(result.result);
  }

  async read(name: string, lines: number): Promise<string> {
    try {
      return await herdrText([
        "agent",
        "read",
        name,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(lines),
      ]);
    } catch {
      return herdrText([
        "agent",
        "read",
        name,
        "--source",
        "visible",
        "--lines",
        String(lines),
      ]);
    }
  }

  async interrupt(name: string): Promise<void> {
    await herdrJson(["agent", "send-keys", name, "esc"]);
  }

  async focus(name: string): Promise<void> {
    await herdrJson(["agent", "focus", name]);
  }

  async reportMetadata(metadata: AgentMetadata): Promise<void> {
    const args = [
      "pane",
      "report-metadata",
      metadata.paneId,
      "--source",
      "pi-herdr-fleet",
      "--title",
      metadata.title,
      "--display-agent",
      metadata.displayAgent,
    ];
    for (const [key, value] of Object.entries(metadata.tokens)) {
      args.push("--token", `${key}=${value}`);
    }
    await herdrJson(args);
  }

  private async chooseSplitDirection(
    callerPane: string,
  ): Promise<"right" | "down"> {
    try {
      // Use the explicit caller pane ID rather than UI focus. Herdr's skill
      // principle is caller-relative topology; explicit IDs also avoid focus races.
      const response = await herdrJson<LayoutResult>([
        "pane",
        "layout",
        "--pane",
        callerPane,
      ]);
      const dims =
        findPaneDimensions(response.result, callerPane) ??
        dimensions(response.result?.area);
      if (!dims) return "right";
      return dims.width / dims.height >= 1.6 ? "right" : "down";
    } catch {
      return "right";
    }
  }
}
