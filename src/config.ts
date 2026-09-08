import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  isThinkingLevel,
  type FleetConfig,
  type RoleOverride,
} from "./types.js";

const DEFAULTS: FleetConfig = {
  runtime: "herdr",
  maxConcurrent: 6,
  maxDepth: 2,
  notifyOnComplete: true,
  recentReadLines: 160,
  defaultWaitTimeoutMs: 120_000,
  closeOnSettle: true,
  roles: {},
};

function readJson(file: string, warnings?: string[]): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return {};
    warnings?.push(
      `pi-herdr-fleet: ignoring unreadable JSON in ${file}: ${err.message}`,
    );
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings?.push(
        `pi-herdr-fleet: ignoring invalid JSON in ${file}: expected a JSON object`,
      );
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings?.push(`pi-herdr-fleet: ignoring invalid JSON in ${file}: ${detail}`);
    return {};
  }
}

function parseRole(value: unknown): RoleOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  return {
    model: typeof v.model === "string" ? v.model : undefined,
    thinking: isThinkingLevel(v.thinking) ? v.thinking : undefined,
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
    defaultThinking: isThinkingLevel(raw.defaultThinking) ? raw.defaultThinking : base.defaultThinking,
    maxConcurrent: typeof raw.maxConcurrent === "number" ? Math.max(1, Math.floor(raw.maxConcurrent)) : base.maxConcurrent,
    maxDepth: typeof raw.maxDepth === "number" ? Math.max(0, Math.floor(raw.maxDepth)) : base.maxDepth,
    notifyOnComplete: typeof raw.notifyOnComplete === "boolean" ? raw.notifyOnComplete : base.notifyOnComplete,
    recentReadLines: typeof raw.recentReadLines === "number" ? Math.max(20, Math.floor(raw.recentReadLines)) : base.recentReadLines,
    defaultWaitTimeoutMs: typeof raw.defaultWaitTimeoutMs === "number" ? Math.max(1, Math.floor(raw.defaultWaitTimeoutMs)) : base.defaultWaitTimeoutMs,
    closeOnSettle: typeof raw.closeOnSettle === "boolean" ? raw.closeOnSettle : base.closeOnSettle,
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

export function loadConfig(cwd: string, warnings?: string[]): FleetConfig {
  const globalPath = path.join(getAgentDir(), "herdr-fleet.json");
  const projectPath = findNearestProjectConfig(cwd);
  return mergeConfig(
    mergeConfig(DEFAULTS, readJson(globalPath, warnings)),
    projectPath ? readJson(projectPath, warnings) : {},
  );
}
