import { describe, expect, it } from "vitest";
import { noteContextLabel } from "./NoteViewerPage";

describe("hosted note context copy", () => {
  it("distinguishes current post context from place and pre-pivot list context", () => {
    expect(noteContextLabel({ kind: "post", postTitle: "A weekend in Lisbon" })).toBe(
      'From the post "A weekend in Lisbon"',
    );
    expect(noteContextLabel({ kind: "list", listTitle: "Lisbon cafés" })).toBe(
      'From the list "Lisbon cafés"',
    );
    expect(
      noteContextLabel({
        kind: "place",
        place: { kind: "manual", name: "Lookout", lat: 38.7, lng: -9.1 },
      }),
    ).toBe("About a shared place");
  });
});
