import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FleetConfig, RoleOverride, ThinkingLevel } from "./types.js";

const DEFAULTS: FleetConfig = {
  runtime: "herdr",
  maxConcurrent: 6,
  maxDepth: 2,
  notifyOnComplete: true,
  recentReadLines: 160,
  roles: {},
};

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isThinking(v: unknown): v is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(v));
}

function parseRole(value: unknown): RoleOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  return {
    model: typeof v.model === "string" ? v.model : undefined,
    thinking: isThinking(v.thinking) ? v.thinking : undefined,
    worktree: typeof v.worktree === "boolean" ? v.worktree : undefined,
    interactive: typeof v.interactive === "boolean" ? v.interactive : undefined,
    spawning: typeof v.spawning === "boolean" ? v.spawning : undefined,
  };
}

function mergeConfig(base: FleetConfig, raw: Record<string, unknown>): FleetConfig {
  const roles = { ...base.roles };
  if (raw.roles && typeof raw.roles === "object" && !Array.isArray(raw.roles)) {
    for (const [name, value] of Object.entries(raw.roles as Record<string, unknown>)) {
      roles[name] = { ...(roles[name] ?? {}), ...parseRole(value) };
    }
  }
  return {
    runtime: "herdr",
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : base.defaultModel,
    defaultThinking: isThinking(raw.defaultThinking) ? raw.defaultThinking : base.defaultThinking,
    maxConcurrent: typeof raw.maxConcurrent === "number" ? Math.max(1, Math.floor(raw.maxConcurrent)) : base.maxConcurrent,
    maxDepth: typeof raw.maxDepth === "number" ? Math.max(0, Math.floor(raw.maxDepth)) : base.maxDepth,
    notifyOnComplete: typeof raw.notifyOnComplete === "boolean" ? raw.notifyOnComplete : base.notifyOnComplete,
    recentReadLines: typeof raw.recentReadLines === "number" ? Math.max(20, Math.floor(raw.recentReadLines)) : base.recentReadLines,
    roles,
  };
}


function findNearestProjectConfig(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".pi", "herdr-fleet.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadConfig(cwd: string): FleetConfig {
  const globalPath = path.join(getAgentDir(), "herdr-fleet.json");
  const projectPath = findNearestProjectConfig(cwd);
  return mergeConfig(mergeConfig(DEFAULTS, readJson(globalPath)), projectPath ? readJson(projectPath) : {});
}
