import { createManualPlace } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "./repo";

const NOW = "2026-07-18T12:00:00.000Z";

describe("Phase 2 membership-backed place updates", () => {
  it("does not let updatePlace become a hidden place-creation path", async () => {
    const repo = new DexieRepository(`phase2-update-place-${crypto.randomUUID()}`);
    try {
      const orphan = createManualPlace(
        "orphan-place",
        { name: "Hidden pin", lat: 51.5, lng: -0.1 },
        NOW,
      );

      await expect(repo.updatePlace(orphan)).rejects.toThrow(/not found|membership/i);
      await expect(repo.getPlace(orphan.id)).resolves.toBeUndefined();
    } finally {
      repo.db.close();
    }
  });
});
