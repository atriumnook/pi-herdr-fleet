import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { makeHerdrName, RunRegistry } from "../src/registry.js";
import type { AgentRun } from "../src/types.js";

test("Herdr names are short and safe", () => {
  const name = makeHerdrName("fleet-12345678", "Security Reviewer", "abcdef12");
  expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
});

test("registry is shared and resolves the latest role instance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-registry-"));
  const file = path.join(dir, "runs.jsonl");
  const a = new RunRegistry(file, "fleet-test");
  const b = new RunRegistry(file, "fleet-test");
  const base: AgentRun = {
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
  };
  a.upsert(base);
  b.upsert({ ...base, id: "22222222", name: "Scout 2", herdrName: "fleet-scout-2", paneId: "w1:p3", startedAt: 2 });
  expect(a.resolve("scout")?.id).toBe("22222222");
  expect(a.byPane("w1:p2")?.id).toBe("11111111");
  expect(b.all()).toHaveLength(2);
});
