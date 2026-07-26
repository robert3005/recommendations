import { describe, expect, it } from "vitest";
import { articleFollowGroups } from "./articleFollow";

describe("article map-follow groups", () => {
  it("assigns consecutive embeds to their prose section and keeps embeds self-focused", () => {
    const groups = articleFollowGroups([
      { blockId: "intro" },
      { blockId: "alpha", placeId: "place-a" },
      { blockId: "bravo", placeId: "place-b" },
      { blockId: "second-section" },
      { blockId: "charlie", placeId: "place-c" },
    ]);

    expect(groups.get("intro")).toEqual(["place-a", "place-b"]);
    expect(groups.get("alpha")).toEqual(["place-a"]);
    expect(groups.get("second-section")).toEqual(["place-c"]);
  });

  it("uses the nearest preceding embed for a trailing prose section", () => {
    const groups = articleFollowGroups([
      { blockId: "place", placeId: "place-a" },
      { blockId: "epilogue" },
    ]);

    expect(groups.get("epilogue")).toEqual(["place-a"]);
  });
});
