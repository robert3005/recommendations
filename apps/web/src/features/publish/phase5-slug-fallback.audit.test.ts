/** Normalization must always produce a valid claimable slug for a named list. */
import { slugSchema } from "@placemarks/schemas";
import { createShareApp, MemoryStorage } from "@placemarks/share-service";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { publishList } from "./publication";

const NOW = "2026-07-19T10:00:00.000Z";

describe("Phase 5 hosted slug fallback", () => {
  it("publishes a list whose name has no ASCII slug characters", async () => {
    const repo = new DexieRepository(`phase5-slug-fallback-${crypto.randomUUID()}`);
    const storage = new MemoryStorage();
    const app = createShareApp({ storage });
    const fetcher: typeof fetch = async (input, init) =>
      app.request(new URL(String(input), "https://share.test").toString(), init);
    try {
      await repo.createList({ id: "list-1", name: "東京 ☕", createdAt: NOW, updatedAt: NOW });
      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Coffee", lat: 35.68, lng: 139.76 } },
        NOW,
      );

      const publication = await publishList(repo, "list-1", NOW, fetcher);

      expect(publication).toMatchObject({ status: "published", publishedRevision: 1 });
      expect(slugSchema.safeParse(publication?.slug).success).toBe(true);
      expect(await storage.get("list", publication?.slug ?? "")).toBeDefined();
    } finally {
      repo.db.close();
    }
  });
});
