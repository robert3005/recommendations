import { describe, expect, it } from "vitest";
import { activeMentionIds, mentionElementFor } from "./articleFollow";

describe("mention-based article↔map sync", () => {
  it("keeps projected mentions in body order and drops the rest", () => {
    const body = [
      "Start at [Café Central](place:place-a), then [Miradouro](place:place-b),",
      "detour to [Elsewhere](place:place-z), back to [the café](place:place-a).",
    ].join("\n");
    expect(activeMentionIds(body, new Set(["place-a", "place-b"]))).toEqual(["place-a", "place-b"]);
  });

  it("returns no mentions for a body without place links", () => {
    expect(
      activeMentionIds("Just prose with [a link](https://example.com).", new Set(["a"])),
    ).toEqual([]);
  });

  it("finds the first rendered mention of a place as the scroll target", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      '<p><button data-mention-place="place-a" id="first">Café Central</button></p>',
      '<p><button data-mention-place="place-b">Miradouro</button></p>',
      '<p><button data-mention-place="place-a" id="second">the café</button></p>',
    ].join("");

    expect(mentionElementFor(root, "place-a")?.id).toBe("first");
    expect(mentionElementFor(root, "place-z")).toBeNull();
  });
});
