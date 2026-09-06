import { describe, expect, test } from "bun:test";
import { decodeHerdrSocketEvent, normalizeHerdrEventName } from "../src/herdr-events.js";

describe("Herdr socket event decoding", () => {
  test("accepts current dotted event names", () => {
    expect(normalizeHerdrEventName("pane.agent_status_changed")).toBe("pane.agent_status_changed");
  });

  test("normalizes legacy/alternate underscore event names", () => {
    expect(normalizeHerdrEventName("pane_agent_status_changed")).toBe("pane.agent_status_changed");
    expect(normalizeHerdrEventName("pane_exited")).toBe("pane.exited");
  });

  test("decodes documented event/data envelopes", () => {
    expect(
      decodeHerdrSocketEvent({
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p2", agent_status: "done" },
      }),
    ).toEqual({
      event: "pane.agent_status_changed",
      data: { pane_id: "w1:p2", agent_status: "done" },
    });
  });

  test("defensively accepts top-level event payload fields", () => {
    expect(
      decodeHerdrSocketEvent({
        type: "pane_moved",
        pane_id: "w1:p2",
        previous_pane_id: "w1:p1",
      }),
    ).toEqual({
      event: "pane.moved",
      data: { pane_id: "w1:p2", previous_pane_id: "w1:p1" },
    });
  });
});
