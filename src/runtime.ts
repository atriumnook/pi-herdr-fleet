import type { AgentState } from "./types.js";

export interface RuntimeLocation {
  paneId: string;
  workspaceId?: string;
  cwd: string;
}

export interface RuntimeAgentState {
  status: AgentState;
}

export interface CreateLocationOptions {
  cwd: string;
  label: string;
  worktree: boolean;
  branch?: string;
  direction?: "right" | "down";
  env: Record<string, string>;
}

export interface AgentMetadata {
  paneId: string;
  title: string;
  displayAgent: string;
  tokens: Record<string, string>;
}

export interface AgentRuntime {
  readonly kind: "herdr";
  createLocation(options: CreateLocationOptions): Promise<RuntimeLocation>;
  start(
    name: string,
    paneId: string,
    agentArgs: string[],
  ): Promise<RuntimeAgentState>;
  closePane(paneId: string): Promise<void>;
  paneExists(paneId: string): Promise<boolean>;
  prompt(name: string, text: string): Promise<RuntimeAgentState>;
  wait(
    name: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<RuntimeAgentState>;
  get(name: string): Promise<RuntimeAgentState>;
  read(name: string, lines: number): Promise<string>;
  interrupt(name: string): Promise<void>;
  focus(name: string): Promise<void>;
  reportMetadata(metadata: AgentMetadata): Promise<void>;
}
