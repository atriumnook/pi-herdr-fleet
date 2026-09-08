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
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = /^[a-z]/.test(normalized)
    ? normalized
    : `a-${normalized || "agent"}`;
  return safe.slice(0, max).replace(/-+$/g, "") || "agent";
}

// POSIX O_APPEND writes are atomic up to PIPE_BUF (4096 on Linux/macOS).
// Node's writeSync with O_APPEND cannot safely resume a partial write: each
// call seeks to the current EOF, so a second syscall can land after another
// process's record and tear a JSONL line. Keep every record, including the
// trailing newline, to one PIPE_BUF-sized write.
export const MAX_REGISTRY_RECORD_BYTES = 4096;

export function makeId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function makeGroupId(): string {
  return `fleet-${crypto.randomBytes(4).toString("hex")}`;
}

export function makeHerdrName(group: string, role: string, id: string): string {
  const suffix = id.slice(0, 4);
  return slug(
    `${group.replace(/^fleet-/, "f")}-${slug(role, 12)}-${suffix}`,
    32,
  );
}

function persistableRun(run: AgentRun): AgentRun {
  // lastOutput is turn preview for same-process notify; it is the field that
  // pushed records past PIPE_BUF. Finalize/notify re-read Herdr when needed.
  const { lastOutput: _lastOutput, ...rest } = run;
  return rest;
}

function encodeLine(event: RegistryEvent): Buffer {
  const payload: RegistryEvent = {
    group: event.group,
    at: event.at,
    run: persistableRun(event.run),
  };
  const encode = (value: RegistryEvent) =>
    Buffer.from(`${JSON.stringify(value)}\n`, "utf8");

  let buf = encode(payload);
  if (buf.length <= MAX_REGISTRY_RECORD_BYTES) return buf;

  const run = { ...payload.run };
  payload.run = run;
  const shrink = (key: "lastError" | "model" | "cwd"): void => {
    while (buf.length > MAX_REGISTRY_RECORD_BYTES) {
      const current = run[key];
      if (typeof current !== "string" || current.length === 0) return;
      const extra = buf.length - MAX_REGISTRY_RECORD_BYTES;
      const minLen = key === "cwd" ? 1 : 0;
      const cut = Math.min(
        current.length - minLen,
        Math.max(1, extra),
      );
      if (cut <= 0) return;
      const next = current.slice(0, current.length - cut);
      if (next) run[key] = next;
      else delete run[key];
      buf = encode(payload);
    }
  };
  shrink("lastError");
  shrink("model");
  shrink("cwd");
  return buf;
}

export class RunRegistry {
  private runs = new Map<string, AgentRun>();
  private parseOffset = 0; // byte offset just past the last fully parsed line
  private statMtimeMs = -1;
  private statSize = -1;

  constructor(
    readonly filePath: string,
    readonly group: string,
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(filePath, "a", 0o600);
    fs.closeSync(fd);
  }

  upsert(run: AgentRun): void {
    this.runs.set(run.id, { ...run });
    const event: RegistryEvent = {
      group: this.group,
      at: Date.now(),
      run,
    };
    const line = encodeLine(event);
    const fd = fs.openSync(this.filePath, "a", 0o600);
    try {
      // One writeSync: O_APPEND plus a buffer <= PIPE_BUF is the atomic unit.
      fs.writeSync(fd, line, 0, line.length);
    } finally {
      fs.closeSync(fd);
    }
  }

  all(): AgentRun[] {
    // The JSONL is append-only and shared by several processes, so parse only
    // the bytes appended since the previous read instead of re-reading and
    // re-parsing the whole file on every registry write.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      this.runs.clear();
      this.parseOffset = 0;
      this.statMtimeMs = -1;
      this.statSize = -1;
      return [];
    }
    if (stat.mtimeMs === this.statMtimeMs && stat.size === this.statSize) {
      return this.sorted();
    }
    if (stat.size < this.parseOffset) {
      // The file was replaced or truncated; start over.
      this.runs.clear();
      this.parseOffset = 0;
    }
    this.statMtimeMs = stat.mtimeMs;
    this.statSize = stat.size;
    if (stat.size === this.parseOffset) return this.sorted();
    let handle: number;
    try {
      handle = fs.openSync(this.filePath, "r");
    } catch {
      return this.sorted();
    }
    try {
      const length = stat.size - this.parseOffset;
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, this.parseOffset);
      // Only consume up to the last complete line; a partial trailing write is
      // re-parsed once its newline arrives.
      const newline = buffer.lastIndexOf(0x0a);
      if (newline >= 0) {
        const complete = buffer.subarray(0, newline + 1).toString("utf8");
        this.parseOffset += newline + 1;
        for (const line of complete.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as RegistryEvent;
            if (event.group === this.group && event.run?.id) {
              const previous = this.runs.get(event.run.id);
              if (previous?.lastOutput && event.run.lastOutput === undefined) {
                event.run.lastOutput = previous.lastOutput;
              }
              this.runs.set(event.run.id, event.run);
            }
          } catch {
            // Ignore a malformed line; one bad write must not poison the cache.
          }
        }
      }
    } finally {
      fs.closeSync(handle);
    }
    return this.sorted();
  }

  private sorted(): AgentRun[] {
    return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt);
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
