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

/** Rewrite the log to latest-per-run once it grows past this many bytes. */
export const COMPACT_MIN_BYTES = 16 * 1024;

/** Compact only when the file is at least this multiple of the latest-state size. */
export const COMPACT_MIN_RATIO = 3;

const LOCK_WAIT_MS = 5;
const LOCK_STALE_MS = 2_000;

export function makeId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/** Registry files untouched for this long belong to sessions that are gone. */
export const STALE_REGISTRY_MS = 7 * 24 * 3_600_000;

/**
 * Each root session appends to its own `<group>.jsonl`; nothing else removes
 * them. Drop siblings of `current` that have not been written for
 * STALE_REGISTRY_MS. A live session writes on every state change, so an
 * mtime this old cannot belong to a fleet that is still doing anything.
 */
export function sweepStaleRegistries(
  current: string,
  now = Date.now(),
): string[] {
  const dir = path.dirname(current);
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const full = path.join(dir, entry);
    if (path.resolve(full) === path.resolve(current)) continue;
    try {
      if (now - fs.statSync(full).mtimeMs < STALE_REGISTRY_MS) continue;
      fs.rmSync(full, { force: true });
      removed.push(full);
    } catch {
      // Already gone or unreadable; nothing to reclaim.
    }
  }
  return removed;
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

function eventKey(event: RegistryEvent): string {
  return `${event.group}\0${event.run.id}`;
}

function parseEvents(text: string): RegistryEvent[] {
  const events: RegistryEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as RegistryEvent;
      if (typeof event.group === "string" && event.run?.id) events.push(event);
    } catch {
      // Ignore a malformed line; one bad write must not poison the cache.
    }
  }
  return events;
}

function latestEvents(events: RegistryEvent[]): RegistryEvent[] {
  const latest = new Map<string, RegistryEvent>();
  for (const event of events) latest.set(eventKey(event), event);
  return [...latest.values()].sort((a, b) => {
    const started = a.run.startedAt - b.run.startedAt;
    if (started !== 0) return started;
    return a.run.id.localeCompare(b.run.id);
  });
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}

function tmpPathFor(filePath: string): string {
  return `${filePath}.rewind`;
}

/**
 * Serialize append + rewind across processes. O_APPEND alone cannot make a
 * rename-over rewrite safe: a writer that opens the path before rename would
 * append onto the orphaned inode.
 */
function withRegistryLock(filePath: string, fn: () => void): void {
  const lockPath = lockPathFor(filePath);
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, Buffer.from(`${process.pid}\n`));
        fn();
        return;
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another process stole a stale lock; the unlink is best-effort.
        }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw error;
      const pid = readLockPid(lockPath);
      const stale =
        (pid !== undefined && !pidAlive(pid)) ||
        (pid === undefined && Date.now() - started >= LOCK_STALE_MS);
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Lost the race to another waiter.
        }
        continue;
      }
      sleepMs(LOCK_WAIT_MS);
    }
  }
}

function mergeRun(previous: AgentRun | undefined, next: AgentRun): AgentRun {
  if (previous?.lastOutput && next.lastOutput === undefined) {
    return { ...next, lastOutput: previous.lastOutput };
  }
  return next;
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
    withRegistryLock(this.filePath, () => {
      const fd = fs.openSync(this.filePath, "a", 0o600);
      try {
        // One writeSync: O_APPEND plus a buffer <= PIPE_BUF is the atomic unit.
        fs.writeSync(fd, line, 0, line.length);
      } finally {
        fs.closeSync(fd);
      }
      this.rewindIfNeeded();
    });
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
      // Rewind/truncate replaced the file. Keep lastOutput (never on disk for
      // new records) while dropping runs that are no longer present.
      const outputs = this.snapshotOutputs();
      this.runs.clear();
      this.parseOffset = 0;
      this.applyCompleteLinesFrom(0, outputs);
      this.statMtimeMs = stat.mtimeMs;
      this.statSize = stat.size;
      return this.sorted();
    }
    this.statMtimeMs = stat.mtimeMs;
    this.statSize = stat.size;
    if (stat.size === this.parseOffset) return this.sorted();
    this.applyCompleteLinesFrom(this.parseOffset);
    return this.sorted();
  }

  private snapshotOutputs(): Map<string, string> {
    const outputs = new Map<string, string>();
    for (const [id, run] of this.runs) {
      if (run.lastOutput) outputs.set(id, run.lastOutput);
    }
    return outputs;
  }

  private applyCompleteLinesFrom(
    start: number,
    outputs?: Map<string, string>,
  ): void {
    let handle: number;
    try {
      handle = fs.openSync(this.filePath, "r");
    } catch {
      return;
    }
    try {
      const actual = fs.fstatSync(handle).size;
      let from = start;
      let restore = outputs;
      if (actual < from) {
        restore = restore ?? this.snapshotOutputs();
        this.runs.clear();
        from = 0;
      }
      const length = actual - from;
      if (length <= 0) {
        this.parseOffset = from;
        return;
      }
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, from);
      // Only consume up to the last complete line; a partial trailing write is
      // re-parsed once its newline arrives.
      const newline = buffer.lastIndexOf(0x0a);
      if (newline < 0) return;
      const complete = buffer.subarray(0, newline + 1).toString("utf8");
      this.parseOffset = from + newline + 1;
      for (const event of parseEvents(complete)) {
        if (event.group !== this.group) continue;
        const previous = this.runs.get(event.run.id);
        const restored =
          restore?.get(event.run.id) && event.run.lastOutput === undefined
            ? { ...event.run, lastOutput: restore.get(event.run.id) }
            : event.run;
        this.runs.set(event.run.id, mergeRun(previous, restored));
      }
    } finally {
      fs.closeSync(handle);
    }
  }

  /**
   * Collapse history to one record per (group, run id). Callers already hold
   * the registry lock so a concurrent upsert cannot append onto a stale inode
   * during rename. Readers that still have a larger parseOffset see size shrink
   * and rebuild from byte 0.
   */
  private rewindIfNeeded(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return;
    }
    if (stat.size < COMPACT_MIN_BYTES) return;

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    const compactEvents = latestEvents(parseEvents(raw));
    const parts = compactEvents.map((event) => encodeLine(event));
    const compactSize = parts.reduce((sum, part) => sum + part.length, 0);
    if (stat.size < compactSize * COMPACT_MIN_RATIO) return;
    if (compactSize >= stat.size) return;

    const tmp = tmpPathFor(this.filePath);
    try {
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        for (const part of parts) fs.writeSync(fd, part, 0, part.length);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.filePath);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Leftover tmp is harmless; the live log is unchanged.
      }
      return;
    }

    const outputs = this.snapshotOutputs();
    this.runs.clear();
    for (const event of compactEvents) {
      if (event.group !== this.group) continue;
      this.runs.set(event.run.id, mergeRun(undefined, event.run));
    }
    for (const [id, output] of outputs) {
      const run = this.runs.get(id);
      if (run && run.lastOutput === undefined) {
        run.lastOutput = output;
      }
    }
    this.parseOffset = compactSize;
    try {
      const next = fs.statSync(this.filePath);
      this.parseOffset = next.size;
      this.statMtimeMs = next.mtimeMs;
      this.statSize = next.size;
    } catch {
      this.statMtimeMs = -1;
      this.statSize = -1;
    }
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
