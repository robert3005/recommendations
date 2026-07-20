/** Owner-confirmed OSM relinks must dirty every hosted guide containing the place. */
import { linkPlaceToOsm, markerAt, type Publication, type ResolvedPoi } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 publication dirtying after place identity repair", () => {
  it("queues a payload-less marker when the owner links a published manual place to OSM", async () => {
    const repo = new DexieRepository(`phase5-place-relink-${crypto.randomUUID()}`);
    try {
      await repo.createList({
        id: "list-1",
        name: "Relink guide",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const manual = (
        await repo.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Owner pin", lat: 38.7139, lng: -9.1394 } },
          NOW,
        )
      ).place;
      const publication: Publication = {
        id: "publication-1",
        target: { kind: "list", id: "list-1" },
        mode: "hosted",
        slug: "relink-guide",
        credentialId: "credential-1",
        status: "published",
        localRevision: "published-v1",
        lastPublishedLocalRevision: "published-v1",
        publishedRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.db.publications.put(publication);

      const resolved: ResolvedPoi = {
        osmRef: { type: "node", id: "101" },
        name: "OSM place",
        category: "cafe",
        lat: 38.7139,
        lng: -9.1394,
        identityTags: { name: "OSM place", amenity: "cafe" },
        resolvedAt: LATER,
      };
      await repo.updatePlace(linkPlaceToOsm(manual, resolved, LATER, "owner-confirmed"));

      expect(await repo.db.publications.get(publication.id)).toMatchObject({
        status: "queued",
        localRevision: expect.not.stringMatching("published-v1"),
      });
      expect(await repo.db.publicationOutbox.toArray()).toEqual([
        expect.objectContaining({
          publicationId: publication.id,
          action: "publish",
          payload: undefined,
        }),
      ]);
    } finally {
      repo.db.close();
    }
  });
});
