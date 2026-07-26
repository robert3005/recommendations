import { describe, expect, it } from "vitest";
import { pivotGuideLayer, stablePivotSuccessor } from "./pivot";

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-02T00:00:00.000Z";

describe("lists-and-posts pivot determinism", () => {
  it("derives graph identity from canonical fields and source-row timestamps", () => {
    const changes = pivotGuideLayer({
      lists: [
        {
          id: "list-1",
          name: "Guide",
          color: "#2563eb",
          createdAt: T0,
          updatedAt: T1,
        },
      ],
      listBlocks: [
        {
          id: "section-1",
          listId: "list-1",
          rank: "a",
          content: { type: "section", noteId: "note-1" },
          createdAt: T0,
          updatedAt: T1,
          // Query indexes are intentionally wrong and must be ignored.
          kind: "place",
          refId: "forged-place",
        },
      ],
      notes: [
        {
          id: "note-1",
          target: { kind: "list", listId: "list-1" },
          createdAt: T0,
          updatedAt: T1,
          targetKey: "place:forged-place",
        },
      ],
      blockNoteAttachments: [],
    });

    expect(changes.posts).toEqual([
      {
        id: "list-1:post",
        title: "Guide",
        listId: "list-1",
        createdAt: T0,
        updatedAt: T1,
      },
    ]);
    expect(changes.postBlocks).toEqual([
      {
        id: "section-1:pb",
        postId: "list-1:post",
        rank: "a",
        content: { type: "section", noteId: "note-1" },
        createdAt: T0,
        updatedAt: T1,
      },
    ]);
    expect(changes.tombstoneListBlocks.get("section-1")).toBe("2026-07-02T00:00:00.001Z");
    expect(changes.retargetNotes.get("note-1")).toEqual({
      postId: "list-1:post",
      updatedAt: "2026-07-02T00:00:00.001Z",
    });
  });

  it("refuses marker exhaustion before returning a duplicate live marker", () => {
    const lists = Array.from({ length: 65 }, (_, index) => ({
      id: `list-${index.toString().padStart(2, "0")}`,
      name: `List ${index}`,
      color: "#2563eb",
      createdAt: T0,
      updatedAt: T0,
    }));

    expect(() =>
      pivotGuideLayer({ lists, listBlocks: [], notes: [], blockNoteAttachments: [] }),
    ).toThrow(/marker capacity.*refused/i);
  });

  it("rejects a source timestamp without a deterministic successor", () => {
    expect(() => stablePivotSuccessor("not-a-timestamp")).toThrow(/invalid timestamp/i);
  });
});
