import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

describe("fleet config loading", () => {
  const previousAgentDir = process.env[AGENT_DIR_ENV];
  let tempUserDir: string | undefined;
  let tempProjectDir: string | undefined;

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previousAgentDir;
    if (tempUserDir) fs.rmSync(tempUserDir, { recursive: true, force: true });
    if (tempProjectDir) fs.rmSync(tempProjectDir, { recursive: true, force: true });
    tempUserDir = undefined;
    tempProjectDir = undefined;
  });

  function isolatedDirs(): { cwd: string; userDir: string } {
    tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-user-config-"));
    tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-project-config-"));
    process.env[AGENT_DIR_ENV] = tempUserDir;
    return { cwd: tempProjectDir, userDir: tempUserDir };
  }

  test("missing config files stay silent and keep defaults", () => {
    const { cwd } = isolatedDirs();
    const warnings: string[] = [];
    const config = loadConfig(cwd, warnings);
    expect(config.maxConcurrent).toBe(6);
    expect(config.defaultWaitTimeoutMs).toBe(120_000);
    expect(warnings).toEqual([]);
  });

  test("broken project JSON is ignored and recorded as a warning with the filename", () => {
    const { cwd } = isolatedDirs();
    const file = path.join(cwd, ".pi", "herdr-fleet.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    const warnings: string[] = [];
    const config = loadConfig(cwd, warnings);
    expect(config.maxConcurrent).toBe(6);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
    expect(warnings[0]).toMatch(/invalid JSON/);
  });

  test("broken global JSON is ignored and recorded as a warning with the filename", () => {
    const { cwd, userDir } = isolatedDirs();
    const file = path.join(userDir, "herdr-fleet.json");
    fs.writeFileSync(file, "null");
    const warnings: string[] = [];
    const config = loadConfig(cwd, warnings);
    expect(config.notifyOnComplete).toBe(true);
    expect(warnings.some((warning) => warning.includes(file))).toBe(true);
  });

  test("defaultWaitTimeoutMs can be overridden from project config", () => {
    const { cwd } = isolatedDirs();
    const file = path.join(cwd, ".pi", "herdr-fleet.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ defaultWaitTimeoutMs: 5000 }));
    const config = loadConfig(cwd);
    expect(config.defaultWaitTimeoutMs).toBe(5000);
  });
});
