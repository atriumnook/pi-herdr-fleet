import { describe, expect, test } from "bun:test";
import { abortError, isAbortError } from "../src/herdr.js";

describe("abort helpers", () => {
  test("detects AbortError by name or ABORT_ERR code", () => {
    const named = new Error("cancelled");
    named.name = "AbortError";
    expect(isAbortError(named)).toBe(true);

    const coded = new Error("killed");
    (coded as Error & { code: string }).code = "ABORT_ERR";
    expect(isAbortError(coded)).toBe(true);

    expect(isAbortError(new Error("timeout"))).toBe(false);
    expect(isAbortError("abort")).toBe(false);
  });

  test("abortError prefers the signal reason", () => {
    const controller = new AbortController();
    const reason = new Error("tool cancelled");
    controller.abort(reason);
    expect(abortError(controller.signal)).toBe(reason);

    const plain = abortError();
    expect(plain.name).toBe("AbortError");
    expect(isAbortError(plain)).toBe(true);
  });
});
