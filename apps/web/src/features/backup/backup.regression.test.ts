import { markerAt } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T13:00:00.000Z";

describe("Phase 3 backup compatibility", () => {
  it("restores a backup containing an imported place", async () => {
    const source = new DexieRepository(`backup-import-source-${crypto.randomUUID()}`);
    const target = new DexieRepository(`backup-import-target-${crypto.randomUUID()}`);

    try {
      await source.createList({
        id: "takeout-list",
        name: "Takeout",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await source.addToList(
        "takeout-list",
        {
          kind: "import",
          facts: { name: "Imported café", lat: 38.7139, lng: -9.1394 },
          externalRef: {
            provider: "google-maps",
            url: "https://www.google.com/maps/place/?q=place_id:example",
            fid: "example",
            importedAt: NOW,
          },
        },
        NOW,
      );

      const archive = await exportBackup(source, NOW);
      await importBackup(target, archive, "replace", LATER);

      const restored = await target.listPlaces();
      expect(restored).toHaveLength(1);
      expect(restored[0]?.place).toMatchObject({
        origin: "import",
        externalRefs: [{ provider: "google-maps", fid: "example" }],
      });
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});
