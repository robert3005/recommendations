import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

describe("DexieRepository regressions", () => {
  it("finds the live SavedPlace after an unsave and resave", async () => {
    const repo = new DexieRepository(`repo-regression-${crypto.randomUUID()}`);
    const placeId = "place-1";

    await repo.db.savedPlaces.bulkPut([
      {
        id: "a-tombstoned-save",
        placeId,
        createdAt: "2026-07-18T10:00:00.000Z",
        updatedAt: "2026-07-18T11:00:00.000Z",
        deleted: true,
      },
      {
        id: "z-live-save",
        placeId,
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
    ]);

    await expect(repo.findSavedPlaceByPlaceId(placeId)).resolves.toMatchObject({
      id: "z-live-save",
      placeId,
    });

    repo.db.close();
  });
});
