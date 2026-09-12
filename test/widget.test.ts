import { describe, expect, test } from "bun:test";
import type { AgentRun } from "../src/types.js";
import {
  buildWidgetView,
  SETTLED_VISIBLE_MS,
  type WidgetTheme,
} from "../src/widget.js";

const theme: WidgetTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
};

const NOW = 1_000_000_000;

function run(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: overrides.id ?? Math.random().toString(16).slice(2, 10),
    name: "scout",
    role: "scout",
    herdrName: "fleet-scout-x",
    paneId: "w1:p1",
    cwd: "/tmp",
    model: "provider/fast",
    thinking: "low",
    state: "working",
    depth: 1,
    interactive: false,
    worktree: false,
    startedAt: NOW - 5_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

function view(runs: AgentRun[], extra: Partial<Parameters<typeof buildWidgetView>[0]> = {}) {
  return buildWidgetView(
    { runs, now: NOW, depth: 0, maxDepth: 2, socket: "connected", ...extra },
    theme,
  );
}

describe("fleet widget view", () => {
  test("no runs clears both the widget and the footer status", () => {
    expect(view([])).toEqual({ lines: [], status: undefined });
  });

  test("a working run is listed with the accent glyph and counted in the status", () => {
    const v = view([run({ state: "working" })]);
    expect(v.status).toContain("<accent>1 working</accent>");
    expect(v.lines).toHaveLength(2);
    expect(v.lines[0]).toContain("<accent>1 working</accent>");
    expect(v.lines[1]).toBe("<accent>●</accent> scout (scout) · fast:low · working");
    expect(v.nextExpiryAt).toBeUndefined();
  });

  test("a blocked run is highlighted as warning in both places", () => {
    const v = view([run({ state: "blocked" })]);
    expect(v.status).toContain("<warning>1 blocked</warning>");
    expect(v.lines[1]).toBe(
      "<warning>?</warning> <warning>scout (scout) · fast:low · blocked</warning>",
    );
  });

  test("a recently settled run is shown muted with an expiry, then disappears", () => {
    const settledAt = NOW - 10_000;
    const runs = [run({ state: "done", updatedAt: settledAt })];
    const recent = view(runs);
    expect(recent.status).toBeUndefined();
    expect(recent.lines[0]).toContain("<dim>settled</dim>");
    expect(recent.lines[1]).toBe(
      "<success>✓</success> <muted>scout (scout) · fast:low · done</muted>",
    );
    expect(recent.nextExpiryAt).toBe(settledAt + SETTLED_VISIBLE_MS);

    const later = view(runs, { now: settledAt + SETTLED_VISIBLE_MS });
    expect(later.lines).toEqual([]);
    expect(later.status).toBeUndefined();
  });

  test("settled runs collapse to the newest per name; attention runs never collapse", () => {
    const v = view([
      run({ id: "a", name: "review", state: "stopped", model: "p/old", startedAt: NOW - 60_000 }),
      run({ id: "b", name: "review", state: "stopped", model: "p/new", startedAt: NOW - 30_000 }),
      run({ id: "c", name: "scout", state: "working", startedAt: NOW - 20_000 }),
      run({ id: "d", name: "scout", state: "working", startedAt: NOW - 10_000 }),
    ]);
    const rows = v.lines.slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.filter((line) => line.includes("review"))).toHaveLength(1);
    expect(rows.find((line) => line.includes("review"))).toContain("new");
    expect(rows.filter((line) => line.includes("working"))).toHaveLength(2);
  });

  test("attention runs come first and the list is capped with an overflow line", () => {
    const runs = [
      ...Array.from({ length: 6 }, (_, i) =>
        run({ id: `s${i}`, name: `settled-${i}`, state: "done", startedAt: NOW - 100_000 + i }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        run({ id: `w${i}`, name: `worker-${i}`, state: "working" }),
      ),
    ];
    const v = view(runs);
    expect(v.lines).toHaveLength(1 + 8 + 1);
    expect(v.lines.slice(1, 5).every((line) => line.includes("working"))).toBe(true);
    expect(v.lines.at(-1)).toBe("<dim>… 2 more</dim>");
  });

  test("nested depth and a degraded socket are surfaced in the header only when relevant", () => {
    const plain = view([run({})]);
    expect(plain.lines[0]).not.toContain("depth");
    expect(plain.lines[0]).not.toContain("events:");
    const nested = view([run({})], { depth: 1, socket: "reconnecting" });
    expect(nested.lines[0]).toContain("<dim>depth 1/2</dim>");
    expect(nested.lines[0]).toContain("<warning>events:reconnecting</warning>");
  });
});
