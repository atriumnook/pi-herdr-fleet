import type { AgentRun } from "./types.js";

/**
 * Minimal view of pi's theme so the widget model stays testable without the
 * TUI. `ctx.ui.theme` satisfies it structurally.
 */
export interface WidgetTheme {
  fg(color: WidgetColor, text: string): string;
}

export type WidgetColor =
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "dim";

export interface WidgetInput {
  runs: AgentRun[];
  now: number;
  depth: number;
  maxDepth: number;
  socket: "connecting" | "connected" | "reconnecting" | "stopped";
}

export interface WidgetView {
  /** Lines for the above-editor widget; empty means the widget is cleared. */
  lines: string[];
  /** Footer status text; undefined means the status is cleared. */
  status?: string;
  /** Epoch ms at which a settled row expires and the view must be recomputed. */
  nextExpiryAt?: number;
}

/**
 * Settled runs stay visible briefly so the outcome is readable at a glance,
 * then leave the editor area. The completion message in the transcript is the
 * durable record; `/fleet` lists everything on demand.
 */
export const SETTLED_VISIBLE_MS = 120_000;

/** Runs that need the user's attention or are still in flight. */
function isAttention(run: AgentRun): boolean {
  return (
    run.state === "starting" ||
    run.state === "working" ||
    run.state === "blocked" ||
    run.state === "unknown"
  );
}

const ICON: Record<AgentRun["state"], { glyph: string; color: WidgetColor }> = {
  starting: { glyph: "…", color: "dim" },
  working: { glyph: "●", color: "accent" },
  blocked: { glyph: "?", color: "warning" },
  unknown: { glyph: "◇", color: "warning" },
  idle: { glyph: "✓", color: "success" },
  done: { glyph: "✓", color: "success" },
  failed: { glyph: "×", color: "error" },
  stopped: { glyph: "■", color: "dim" },
};

function modelLabel(model?: string): string {
  if (!model) return "inherit";
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function rowText(run: AgentRun): string {
  const thinking = run.thinking ? `:${run.thinking}` : "";
  const wt = run.worktree ? " · wt" : "";
  return `${run.name} (${run.role}) · ${modelLabel(run.model)}${thinking} · ${run.state}${wt}`;
}

function row(run: AgentRun, theme: WidgetTheme): string {
  const icon = ICON[run.state];
  const text = rowText(run);
  switch (run.state) {
    case "blocked":
      return `${theme.fg(icon.color, icon.glyph)} ${theme.fg("warning", text)}`;
    case "working":
    case "starting":
    case "unknown":
    case "failed":
      return `${theme.fg(icon.color, icon.glyph)} ${text}`;
    default:
      return `${theme.fg(icon.color, icon.glyph)} ${theme.fg("muted", text)}`;
  }
}

/**
 * Settled runs collapse to the newest per name: a re-spawn supersedes the
 * earlier attempt, and two rows with the same name only say "this happened
 * twice", which the transcript already records.
 */
function latestPerName(runs: AgentRun[]): AgentRun[] {
  const byName = new Map<string, AgentRun>();
  for (const run of runs) {
    const current = byName.get(run.name);
    if (!current || run.startedAt > current.startedAt) byName.set(run.name, run);
  }
  return [...byName.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function buildWidgetView(
  input: WidgetInput,
  theme: WidgetTheme,
): WidgetView {
  const { runs, now } = input;
  const attention = runs.filter(isAttention);
  const recentSettled = latestPerName(
    runs.filter((run) => !isAttention(run)),
  ).filter((run) => now - run.updatedAt < SETTLED_VISIBLE_MS);

  const working = attention.filter(
    (run) => run.state === "working" || run.state === "starting",
  ).length;
  const blocked = attention.filter((run) => run.state === "blocked").length;
  const unknown = attention.filter((run) => run.state === "unknown").length;

  let status: string | undefined;
  if (attention.length) {
    const parts: string[] = [];
    if (working) parts.push(theme.fg("accent", `${working} working`));
    if (blocked) parts.push(theme.fg("warning", `${blocked} blocked`));
    if (unknown) parts.push(theme.fg("warning", `${unknown} unknown`));
    status = `${theme.fg("muted", "fleet")} ${parts.join(theme.fg("dim", " · "))}`;
  }

  if (!attention.length && !recentSettled.length) return { lines: [], status };

  const headerParts = [theme.fg("muted", "Fleet")];
  if (working) headerParts.push(theme.fg("accent", `${working} working`));
  if (blocked) headerParts.push(theme.fg("warning", `${blocked} blocked`));
  if (unknown) headerParts.push(theme.fg("warning", `${unknown} unknown`));
  if (!attention.length) headerParts.push(theme.fg("dim", "settled"));
  if (input.depth > 0)
    headerParts.push(theme.fg("dim", `depth ${input.depth}/${input.maxDepth}`));
  if (input.socket !== "connected")
    headerParts.push(theme.fg("warning", `events:${input.socket}`));

  const lines = [headerParts.join(theme.fg("dim", " · "))];
  for (const run of [...attention, ...recentSettled].slice(0, 8)) {
    lines.push(row(run, theme));
  }
  const overflow = attention.length + recentSettled.length - (lines.length - 1);
  if (overflow > 0) lines.push(theme.fg("dim", `… ${overflow} more`));

  const nextExpiryAt = recentSettled.length
    ? Math.min(...recentSettled.map((run) => run.updatedAt + SETTLED_VISIBLE_MS))
    : undefined;
  return { lines, status, nextExpiryAt };
}
