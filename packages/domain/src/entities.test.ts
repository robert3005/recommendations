import { describe, expect, it } from "vitest";
import { compareByRank, osmRefKey, postTargetKey, publicationTargetKey } from "./entities";

describe("target keys", () => {
  it("keys a post target by its kind", () => {
    expect(postTargetKey({ kind: "list", listId: "l1" })).toBe("list:l1");
    expect(postTargetKey({ kind: "place", placeId: "p1" })).toBe("place:p1");
  });

  it("keys a publication target by its kind", () => {
    expect(publicationTargetKey({ kind: "list", id: "l1" })).toBe("list:l1");
    expect(publicationTargetKey({ kind: "post", id: "p9" })).toBe("post:p9");
  });

  it("keys an OSM ref as type/id", () => {
    expect(osmRefKey({ type: "node", id: "123" })).toBe("node/123");
    expect(osmRefKey({ type: "relation", id: "7" })).toBe("relation/7");
  });
});

describe("compareByRank", () => {
  it("orders by rank, then id as the tiebreaker", () => {
    const rows = [
      { rank: "a1", id: "b" },
      { rank: "a0", id: "z" },
      { rank: "a1", id: "a" },
    ];
    expect(rows.sort(compareByRank).map((r) => r.id)).toEqual(["z", "a", "b"]);
  });
});
