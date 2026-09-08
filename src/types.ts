export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  thinking?: ThinkingLevel;
  cwd?: string;
  worktree?: boolean;
  interactive?: boolean;
  direction?: "right" | "down";
}
