/**
 * Regression: live rows must never be shadowed by tombstoned siblings sharing an
 * index key (originally found on the saves table; the membership-is-existence
 * model moved the hazard to places sharing an OSM refKey).
 */
import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

describe("DexieRepository regressions", () => {
  it("finds the live place by OSM ref when a tombstoned one shares the refKey", async () => {
    const repo = new DexieRepository(`repo-regression-${crypto.randomUUID()}`);
    const base = {
      origin: "osm" as const,
      currentOsmRef: { type: "node" as const, id: "101" },
      currentOsmLinkedAt: "2026-07-18T10:00:00.000Z",
      osmRefHistory: [],
      resolutionState: "resolved" as const,
      createdAt: "2026-07-18T10:00:00.000Z",
      updatedAt: "2026-07-18T10:00:00.000Z",
      refKeys: ["node/101"],
    };
    await repo.db.places.bulkPut([
      { ...base, id: "a-tombstoned-place", deleted: true },
      { ...base, id: "z-live-place", updatedAt: "2026-07-18T12:00:00.000Z" },
    ]);

    await expect(repo.findPlaceByOsmRef({ type: "node", id: "101" })).resolves.toMatchObject({
      id: "z-live-place",
    });

    repo.db.close();
  });
});
