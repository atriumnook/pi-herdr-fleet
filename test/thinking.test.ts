import { describe, expect, test } from "bun:test";
import {
  parseThinkingLevel,
  requireThinkingLevel,
} from "../src/types.js";

describe("thinking levels", () => {
  test("parseThinkingLevel ignores unknown values", () => {
    expect(parseThinkingLevel("medium")).toBe("medium");
    expect(parseThinkingLevel("turbo")).toBeUndefined();
    expect(parseThinkingLevel("HIGH")).toBeUndefined();
    expect(parseThinkingLevel("")).toBeUndefined();
  });

  test("requireThinkingLevel rejects unknown values with a clear error", () => {
    expect(requireThinkingLevel(undefined)).toBeUndefined();
    expect(requireThinkingLevel("low")).toBe("low");
    expect(() => requireThinkingLevel("turbo")).toThrow(
      /Invalid thinking level "turbo"/,
    );
    expect(() => requireThinkingLevel("")).toThrow(/Invalid thinking level ""/);
    expect(() => requireThinkingLevel(1)).toThrow(/Invalid thinking level 1/);
  });
});
