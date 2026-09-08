import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { discoverAgents } from "../src/agents.js";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

describe("bundled agent discovery", () => {
  const previousAgentDir = process.env[AGENT_DIR_ENV];
  let tempUserDir: string | undefined;

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previousAgentDir;
    if (tempUserDir) fs.rmSync(tempUserDir, { recursive: true, force: true });
    tempUserDir = undefined;
  });

  function isolatedCwd(): string {
    tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-user-agents-"));
    process.env[AGENT_DIR_ENV] = tempUserDir;
    return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-project-"));
  }

  test("loads scout, planner, worker, and reviewer from bundled markdown", () => {
    const agents = discoverAgents(isolatedCwd());
    const names = agents.map((a) => a.name).sort();
    expect(names).toEqual(["planner", "reviewer", "scout", "worker"]);
    const scout = agents.find((a) => a.name === "scout");
    expect(scout?.description).toContain("reconnaissance");
    expect(scout?.source).toBe("bundled");
    expect(scout?.tools).toContain("read");
    expect(scout?.spawning).toBe(false);
  });

  test("unquoted YAML description does not drop bundled scout or abort discovery", () => {
    const cwd = isolatedCwd();
    const projectAgents = path.join(cwd, ".pi", "agents");
    fs.mkdirSync(projectAgents, { recursive: true });
    fs.writeFileSync(
      path.join(projectAgents, "scout.md"),
      [
        "---",
        "name: scout",
        "description: Fast read-only reconnaissance: locate files, trace behavior",
        "---",
        "Broken project scout should be skipped.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(projectAgents, "helper.md"),
      [
        "---",
        "name: helper",
        'description: "A valid project role"',
        "---",
        "You are a helper.",
        "",
      ].join("\n"),
    );

    const agents = discoverAgents(cwd);
    const scout = agents.find((a) => a.name === "scout");
    expect(scout?.source).toBe("bundled");
    expect(scout?.description).toContain("reconnaissance");
    expect(agents.some((a) => a.name === "helper")).toBe(true);
  });
});
