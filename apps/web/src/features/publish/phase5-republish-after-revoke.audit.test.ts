/** The creator UI offers publishing again after revocation, under a fresh slug claim. */
import { markerAt } from "@placemarks/domain";
import { createShareApp, MemoryStorage } from "@placemarks/share-service";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { publishList, revokePublication } from "./publication";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 publishing after revocation", () => {
  it("creates a working new link instead of trying to update the tombstoned slug", async () => {
    const repo = new DexieRepository(`phase5-republish-${crypto.randomUUID()}`);
    const storage = new MemoryStorage();
    const app = createShareApp({ storage });
    const fetcher: typeof fetch = async (input, init) =>
      app.request(new URL(String(input), "https://share.test").toString(), init);
    try {
      await repo.createList({
        id: "list-1",
        name: "Republish me",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "A place", lat: 38.71, lng: -9.14 } },
        NOW,
      );
      const first = await publishList(repo, "list-1", NOW, fetcher);
      if (!first?.slug) throw new Error("first publication missing");
      await revokePublication(repo, first.id, LATER, fetcher);
      expect((await storage.get("list", first.slug))?.revoked).toBe(true);

      const replacement = await publishList(repo, "list-1", LATER, fetcher);

      expect(replacement).toMatchObject({ status: "published", publishedRevision: 1 });
      expect(replacement?.slug).not.toBe(first.slug);
      expect((await app.request(`https://share.test/s/lists/${first.slug}`)).status).toBe(404);
      expect(
        (await app.request(`https://share.test/s/lists/${replacement?.slug ?? ""}`)).status,
      ).toBe(200);
    } finally {
      repo.db.close();
    }
  });
});
