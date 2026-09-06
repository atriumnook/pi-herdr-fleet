import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentRun } from "./types.js";

interface RegistryEvent {
  group: string;
  at: number;
  run: AgentRun;
}

function slug(value: string, max = 20): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const safe = /^[a-z]/.test(normalized) ? normalized : `a-${normalized || "agent"}`;
  return safe.slice(0, max).replace(/-+$/g, "") || "agent";
}

export function makeId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function makeGroupId(): string {
  return `fleet-${crypto.randomBytes(4).toString("hex")}`;
}

export function makeHerdrName(group: string, role: string, id: string): string {
  const suffix = id.slice(0, 4);
  return slug(`${group.replace(/^fleet-/, "f")}-${slug(role, 12)}-${suffix}`, 32);
}

export class RunRegistry {
  constructor(
    readonly filePath: string,
    readonly group: string,
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(filePath, "a", 0o600);
    fs.closeSync(fd);
  }

  upsert(run: AgentRun): void {
    const event: RegistryEvent = { group: this.group, at: Date.now(), run: { ...run } };
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  all(): AgentRun[] {
    let text = "";
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    const map = new Map<string, AgentRun>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as RegistryEvent;
        if (event.group === this.group && event.run?.id) map.set(event.run.id, event.run);
      } catch {
        // Ignore a partial trailing line after an interrupted write.
      }
    }
    return [...map.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  byPane(paneId: string): AgentRun | undefined {
    return this.all()
      .filter((run) => run.paneId === paneId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  resolve(target: string): AgentRun | undefined {
    const lowered = target.toLowerCase();
    return this.all()
      .filter(
        (r) =>
          r.id.toLowerCase() === lowered ||
          r.name.toLowerCase() === lowered ||
          r.role.toLowerCase() === lowered ||
          r.herdrName.toLowerCase() === lowered ||
          r.paneId.toLowerCase() === lowered,
      )
      .sort((a, b) => b.startedAt - a.startedAt)[0];
  }
}
