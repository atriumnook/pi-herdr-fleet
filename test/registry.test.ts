import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { makeHerdrName, RunRegistry } from "../src/registry.js";
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
  test("caps persisted lastOutput so long sessions stay parseable", () => {
    const { a } = tempRegistry();
    const lastOutput = "x".repeat(5000);
    a.upsert(run({ lastOutput }));
    const stored = a.all()[0]?.lastOutput ?? "";
    expect(stored.length).toBe(4000);
    expect(stored).toBe(lastOutput.slice(-4000));
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
