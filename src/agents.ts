import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parseThinkingLevel, type AgentDefinition } from "./types.js";

type Frontmatter = {
  name?: unknown;
  description?: unknown;
  model?: unknown;
  thinking?: unknown;
  tools?: unknown;
  worktree?: unknown;
  interactive?: unknown;
  spawning?: unknown;
};

function parseList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out = raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function loadDir(
  dir: string,
  source: AgentDefinition["source"],
  warnings?: string[],
): AgentDefinition[] {
  if (!fs.existsSync(dir)) return [];
  const result: AgentDefinition[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const { frontmatter, body } = parseFrontmatter<Frontmatter>(fs.readFileSync(filePath, "utf8"));
      const fallbackName = path.basename(entry.name, ".md");
      const name = typeof frontmatter.name === "string" ? frontmatter.name : fallbackName;
      const description = typeof frontmatter.description === "string" ? frontmatter.description : name;
      result.push({
        name,
        description,
        model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
        thinking: parseThinkingLevel(frontmatter.thinking),
        tools: parseList(frontmatter.tools),
        worktree: typeof frontmatter.worktree === "boolean" ? frontmatter.worktree : undefined,
        interactive: typeof frontmatter.interactive === "boolean" ? frontmatter.interactive : undefined,
        spawning: typeof frontmatter.spawning === "boolean" ? frontmatter.spawning : undefined,
        systemPrompt: body.trim(),
        source,
        filePath,
      });
    } catch (error) {
      // Invalid agent files are isolated; one bad definition must not break discovery.
      const detail = error instanceof Error ? error.message : String(error);
      warnings?.push(
        `pi-herdr-fleet: skipping invalid agent file ${filePath}: ${detail}`,
      );
    }
  }
  return result;
}


function findNearestProjectDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function discoverAgents(cwd: string, warnings?: string[]): AgentDefinition[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundledDir = path.resolve(here, "..", "agents");
  const userDir = path.join(getAgentDir(), "agents");
  const projectDir = findNearestProjectDir(cwd);

  const map = new Map<string, AgentDefinition>();
  for (const agent of loadDir(bundledDir, "bundled", warnings)) map.set(agent.name.toLowerCase(), agent);
  for (const agent of loadDir(userDir, "user", warnings)) map.set(agent.name.toLowerCase(), agent);
  if (projectDir) for (const agent of loadDir(projectDir, "project", warnings)) map.set(agent.name.toLowerCase(), agent);
  return [...map.values()];
}

export function findAgent(agents: AgentDefinition[], role: string): AgentDefinition | undefined {
  return agents.find((a) => a.name.toLowerCase() === role.toLowerCase());
}
