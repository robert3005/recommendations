/**
 * An owner-confirmed OSM relink changes what a containing hosted guide would
 * publish. It must NOT auto-republish: the divergence shows as the list's
 * current projection no longer hashing to lastPublishedHash.
 */
import { linkPlaceToOsm, markerAt, type Publication, type ResolvedPoi } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { projectList } from "../share/project";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("publication freshness after place identity repair", () => {
  it("diverges the published hash when the owner links a published manual place to OSM", async () => {
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
        slug: "relink-guide",
        credentialId: "credential-1",
        status: "published",
        lastPublishedHash: "published-v1",
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

      // The public page is untouched and nothing is queued...
      expect(await repo.db.publications.get(publication.id)).toMatchObject({
        status: "published",
        lastPublishedHash: "published-v1",
      });
      expect(await repo.db.publicationJobs.count()).toBe(0);
      // ...but the list would now publish something different, which is what
      // the "local changes not yet published" badge reads.
      const projection = await projectList(repo, "list-1");
      expect(projection?.guide.contentHash).not.toBe("published-v1");
    } finally {
      repo.db.close();
    }
  });
});
