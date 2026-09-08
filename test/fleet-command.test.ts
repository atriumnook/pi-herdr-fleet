import { describe, expect, test } from "bun:test";
import { parseFleetCommand } from "../src/fleet-command.js";

describe("parseFleetCommand", () => {
  test("empty and unknown args list the fleet", () => {
    expect(parseFleetCommand("")).toEqual({ action: "status" });
    expect(parseFleetCommand("  ")).toEqual({ action: "status" });
    expect(parseFleetCommand("help")).toEqual({ action: "status" });
    expect(parseFleetCommand("close all")).toEqual({ action: "status" });
  });

  test("close and close done bulk-close done panes", () => {
    expect(parseFleetCommand("close")).toEqual({ action: "close-done" });
    expect(parseFleetCommand(" close done ")).toEqual({ action: "close-done" });
    expect(parseFleetCommand("CLOSE-DONE")).toEqual({ action: "close-done" });
  });
});
