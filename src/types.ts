export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
  );
}

/** Config / frontmatter: drop unknown values instead of failing the file. */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return isThinkingLevel(value) ? value : undefined;
}

/** Spawn-time: an explicit value must be a known level. */
export function requireThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null) return undefined;
  if (isThinkingLevel(value)) return value;
  throw new Error(
    `Invalid thinking level ${JSON.stringify(value)}. Use one of: ${THINKING_LEVELS.join(", ")}.`,
  );
}

export type AgentState =
  | "starting"
  | "working"
  | "idle"
  | "done"
  | "blocked"
  | "unknown"
  | "failed"
  | "stopped";

export interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPrompt: string;
  worktree?: boolean;
  interactive?: boolean;
  spawning?: boolean;
  source: "project" | "user" | "bundled";
  filePath: string;
}

export interface RoleOverride {
  model?: string;
  thinking?: ThinkingLevel;
  worktree?: boolean;
  interactive?: boolean;
  spawning?: boolean;
}

export interface FleetConfig {
  runtime: "herdr";
  defaultModel?: string;
  defaultThinking?: ThinkingLevel;
  maxConcurrent: number;
  maxDepth: number;
  notifyOnComplete: boolean;
  recentReadLines: number;
  defaultWaitTimeoutMs: number;
  closeOnSettle: boolean;
  roles: Record<string, RoleOverride>;
}

export interface AgentRun {
  id: string;
  name: string;
  role: string;
  herdrName: string;
  paneId: string;
  workspaceId?: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  state: AgentState;
  depth: number;
  interactive: boolean;
  worktree: boolean;
  startedAt: number;
  updatedAt: number;
  lastOutput?: string;
  lastError?: string;
}

export interface SpawnRequest {
  name?: string;
  role: string;
  task: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  worktree?: boolean;
  interactive?: boolean;
  direction?: "right" | "down";
}
