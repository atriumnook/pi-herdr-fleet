import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  makeHerdrName,
  MAX_REGISTRY_RECORD_BYTES,
  RunRegistry,
} from "../src/registry.js";
import type { AgentRun } from "../src/types.js";

function tempRegistry(): { file: string; a: RunRegistry; b: RunRegistry } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-registry-"));
  const file = path.join(dir, "runs.jsonl");
  return { file, a: new RunRegistry(file, "fleet-test"), b: new RunRegistry(file, "fleet-test") };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "11111111",
    name: "Scout 1",
    role: "scout",
    herdrName: "fleet-scout-1",
    paneId: "w1:p2",
    cwd: "/tmp/repo",
    state: "working",
    depth: 1,
    interactive: false,
    worktree: false,
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("Herdr names are short and safe", () => {
  const name = makeHerdrName("fleet-12345678", "Security Reviewer", "abcdef12");
  expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
});

test("registry is shared and resolves the latest role instance", () => {
  const { a, b } = tempRegistry();
  const base = run();
  a.upsert(base);
  b.upsert({ ...base, id: "22222222", name: "Scout 2", herdrName: "fleet-scout-2", paneId: "w1:p3", startedAt: 2 });
  expect(a.resolve("scout")?.id).toBe("22222222");
  expect(a.byPane("w1:p2")?.id).toBe("11111111");
  expect(b.all()).toHaveLength(2);
});

describe("append-only registry caching", () => {
  test("does not persist lastOutput, but keeps it in the writing process", () => {
    const { file, a, b } = tempRegistry();
    const lastOutput = "x".repeat(5000);
    a.upsert(run({ lastOutput }));
    const disk = fs.readFileSync(file, "utf8");
    expect(disk).not.toContain("lastOutput");
    expect(a.all()[0]?.lastOutput).toBe(lastOutput);
    expect(b.all()[0]?.lastOutput).toBeUndefined();
  });

  test("keeps each JSONL record within PIPE_BUF including a huge lastError", () => {
    const { file, a, b } = tempRegistry();
    a.upsert(
      run({
        lastOutput: "out".repeat(3000),
        lastError: "e".repeat(8000),
        cwd: `/${"very-long-segment/".repeat(40)}repo`,
        model: "provider/an-unusually-long-model-id:thinking",
      }),
    );
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim());
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(`${lines[0]}\n`, "utf8")).toBeLessThanOrEqual(
      MAX_REGISTRY_RECORD_BYTES,
    );
    const parsed = JSON.parse(lines[0] ?? "") as { run?: { lastError?: string } };
    expect(parsed.run?.lastError).toBeDefined();
    expect(parsed.run?.lastError?.length ?? 0).toBeLessThan(8000);
    expect(b.all()).toHaveLength(1);
    expect(b.all()[0]?.id).toBe("11111111");
  });

  test("concurrent upserts from two writers stay parseable JSONL lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-registry-"));
    const file = path.join(dir, "runs.jsonl");
    const writers = [
      new RunRegistry(file, "fleet-test"),
      new RunRegistry(file, "fleet-test"),
    ];
    const perWriter = 40;
    for (let n = 0; n < perWriter; n++) {
      writers[0]?.upsert(
        run({
          id: `a${n.toString().padStart(7, "0")}`,
          lastOutput: "x".repeat(6000),
          lastError: "err".repeat(2000),
          startedAt: n,
        }),
      );
      writers[1]?.upsert(
        run({
          id: `b${n.toString().padStart(7, "0")}`,
          paneId: "w1:p9",
          lastOutput: "y".repeat(6000),
          lastError: "err".repeat(2000),
          startedAt: n + 1000,
        }),
      );
    }
    const lines = fs
      .readFileSync(file)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim());
    for (const line of lines) {
      expect(Buffer.byteLength(`${line}\n`, "utf8")).toBeLessThanOrEqual(
        MAX_REGISTRY_RECORD_BYTES,
      );
      JSON.parse(line);
    }
    const reader = new RunRegistry(file, "fleet-test");
    expect(reader.all()).toHaveLength(perWriter * 2);
  });

  test("still reads legacy records that stored lastOutput", () => {
    const { file, a } = tempRegistry();
    const event = {
      group: "fleet-test",
      at: 1,
      run: run({ lastOutput: "legacy preview" }),
    };
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
    expect(a.all()[0]?.lastOutput).toBe("legacy preview");
  });

  test("parses only newly appended bytes across registry instances", () => {
    const { a, b } = tempRegistry();
    a.upsert(run({ state: "starting" }));
    expect(b.all()[0]?.state).toBe("starting");
    a.upsert(run({ state: "working", updatedAt: 2 }));
    expect(b.all()[0]?.state).toBe("working");
    expect(b.all()).toHaveLength(1);
  });

  test("skips a malformed line without poisoning later events", () => {
    const { file, a, b } = tempRegistry();
    a.upsert(run());
    fs.appendFileSync(file, "this is not json\n");
    a.upsert(run({ state: "done", updatedAt: 3 }));
    expect(b.all()[0]?.state).toBe("done");
    expect(b.all()).toHaveLength(1);
  });

  test("rebuilds the cache when the file is truncated", () => {
    const { file, a } = tempRegistry();
    a.upsert(run());
    expect(a.all()).toHaveLength(1);
    fs.writeFileSync(file, "");
    expect(a.all()).toHaveLength(0);
  });
});
