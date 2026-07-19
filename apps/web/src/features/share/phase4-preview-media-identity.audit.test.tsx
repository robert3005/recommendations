/**
 * Phase 4's preflight is an exact disclosure surface, not a yes/no summary:
 * copied identity records need both stable-id keys and values, and every
 * snapshot image omission needs a human-readable identity before generation.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { projectGuide } from "./project";
import { SharePreview } from "./SharePreview";

const NOW = "2026-07-19T12:00:00.000Z";

const stats = {
  places: 1,
  sections: 0,
  sharedNotes: 0,
  omittedPlaces: 0,
  imagesOmitted: false,
};

describe("Phase 4 exact preview disclosure", () => {
  it("names stable-id keys as well as their values", () => {
    const evidence = {
      osmRef: { type: "node" as const, id: "101" },
      source: "OpenStreetMap" as const,
      license: "ODbL-1.0" as const,
      attribution: "© OpenStreetMap contributors" as const,
      name: "Identity-rich cafe",
      category: "cafe",
      lat: 38.7139,
      lng: -9.1394,
      stableIds: {
        wikidata: "Q123",
        "brand:wikidata": "Q456",
        "ref:vatin": "PT-987654321",
      },
      observedAt: NOW,
    };
    const guide: SharedGuide = {
      v: 1,
      title: "Identity disclosure",
      blocks: [
        {
          id: "place-1",
          type: "place",
          place: {
            kind: "osm",
            currentOsmRef: evidence.osmRef,
            firstSeen: evidence,
            lastVerified: evidence,
          },
        },
      ],
      contentHash: "fixture",
    };

    render(
      <SharePreview
        title={guide.title}
        guide={guide}
        stats={stats}
        snapshotUrl="https://app.example/l#fixture"
        compressedBytes={123}
        copied={false}
        onCopy={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const disclosure = screen.getByTestId("share-payload").textContent ?? "";
    expect(disclosure).toMatch(/wikidata[\s\S]*?Q123/i);
    expect(disclosure).toMatch(/brand(?::|\s+)wikidata[\s\S]*?Q456/i);
    expect(disclosure).toMatch(
      /(?:ref[:\s-]*vatin|VAT(?:IN)?\s+(?:reference|id|identifier))[\s\S]*?PT-987654321/i,
    );
  });

  it("identifies each omitted image instead of showing only a generic boolean notice", async () => {
    const repo = new DexieRepository(`phase4-media-disclosure-${crypto.randomUUID()}`);
    try {
      await repo.createList({ id: "list-1", name: "Media guide", createdAt: NOW, updatedAt: NOW });
      const place = await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Viewpoint", lat: 38.7, lng: -9.1 } },
        NOW,
      );
      await repo.createNote({
        id: "note-1",
        target: { kind: "place", placeId: place.place.id },
        body:
          "![Sunset from the terrace](asset:media-sunset)\n\n" +
          "![Handwritten dinner menu](asset:media-menu)",
        mediaIds: ["media-sunset", "media-menu"],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const projection = await projectGuide(repo, "list-1");
      if (!projection) throw new Error("projection missing");
      render(
        <SharePreview
          title={projection.guide.title}
          guide={projection.guide}
          stats={projection.stats}
          snapshotUrl="https://app.example/l#fixture"
          compressedBytes={123}
          copied={false}
          onCopy={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      const disclosure = screen.getByTestId("share-preview").textContent ?? "";
      expect(disclosure).toContain("Sunset from the terrace");
      expect(disclosure).toContain("Handwritten dinner menu");
    } finally {
      repo.db.close();
    }
  });
});

describe("Phase 4 snapshot media privacy", () => {
  it("removes inline remote-image destinations from the fragment payload", async () => {
    const repo = new DexieRepository(`phase4-remote-image-${crypto.randomUUID()}`);
    const privateImageUrl = "https://private.example/photo.jpg?access_token=family-secret";
    try {
      await repo.createList({ id: "list-1", name: "Remote image", createdAt: NOW, updatedAt: NOW });
      const place = await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Viewpoint", lat: 38.7, lng: -9.1 } },
        NOW,
      );
      await repo.createNote({
        id: "note-1",
        target: { kind: "place", placeId: place.place.id },
        body: `Before ![Private family photo](${privateImageUrl}) after`,
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const projection = await projectGuide(repo, "list-1");
      if (!projection) throw new Error("projection missing");
      const payload = JSON.stringify(projection.guide);

      expect(payload).not.toContain(privateImageUrl);
      expect(payload).not.toContain("family-secret");
      expect(payload).toContain("image omitted");
      expect(projection.stats.imagesOmitted).toBe(true);
    } finally {
      repo.db.close();
    }
  });
});
