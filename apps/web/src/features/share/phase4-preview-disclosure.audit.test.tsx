/** Exact pre-publication disclosure required by book/src/sharing.md. */
import type { SharedGuide } from "@placemarks/schemas";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SharePreview } from "./SharePreview";

const guide: SharedGuide = {
  v: 1,
  title: "Exact disclosure guide",
  blocks: [
    {
      id: "osm-block",
      type: "place",
      place: {
        kind: "osm",
        currentOsmRef: { type: "relation", id: "303" },
        firstSeen: {
          osmRef: { type: "node", id: "101" },
          osmVersion: 7413,
          source: "OpenStreetMap",
          license: "ODbL-1.0",
          attribution: "© OpenStreetMap contributors",
          name: "First observed name",
          category: "cafe",
          lat: 10.123456,
          lng: 20.654321,
          address: "First observed address",
          website: "https://first.example/path",
          phone: "+44 20 7000 0101",
          stableIds: { wikidata: "QFIRST" },
          observedAt: "2024-01-02T03:04:05.000Z",
        },
        lastVerified: {
          osmRef: { type: "way", id: "202" },
          osmVersion: 9827,
          source: "OpenStreetMap",
          license: "ODbL-1.0",
          attribution: "© OpenStreetMap contributors",
          name: "Last verified name",
          category: "restaurant",
          lat: 11.234567,
          lng: 21.765432,
          address: "Last verified address",
          website: "https://last.example/path",
          phone: "+44 20 7000 0202",
          stableIds: { wikidata: "QLAST" },
          observedAt: "2025-06-07T08:09:10.000Z",
        },
      },
      notes: [{ body: "This prose leaves too" }],
    },
    {
      id: "manual-block",
      type: "place",
      place: {
        kind: "manual",
        name: "Manual exact pin",
        lat: -33.123456,
        lng: 151.654321,
        category: "viewpoint",
      },
    },
  ],
  contentHash: "fixture",
};

describe("Phase 4 share-preview disclosure", () => {
  it("shows every copied OSM-evidence and manual-pin value that leaves the device", () => {
    render(
      <SharePreview
        title={guide.title}
        guide={guide}
        stats={{ places: 2, sections: 0, sharedNotes: 1, omittedPlaces: 0, imagesOmitted: false }}
        snapshotUrl="https://app.example/l#fixture"
        compressedBytes={123}
        copied={false}
        onCopy={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const text = screen.getByTestId("share-preview").textContent ?? "";
    const valuesThatLeave = [
      "relation/303",
      "node/101",
      "7413",
      "First observed name",
      "cafe",
      "10.123456",
      "20.654321",
      "First observed address",
      "https://first.example/path",
      "+44 20 7000 0101",
      "QFIRST",
      "2024-01-02T03:04:05.000Z",
      "way/202",
      "9827",
      "Last verified name",
      "restaurant",
      "11.234567",
      "21.765432",
      "Last verified address",
      "https://last.example/path",
      "+44 20 7000 0202",
      "QLAST",
      "2025-06-07T08:09:10.000Z",
      "ODbL-1.0",
      "Manual exact pin",
      "-33.123456",
      "151.654321",
      "viewpoint",
      "This prose leaves too",
    ];
    const missing = valuesThatLeave.filter((value) => !text.includes(value));

    expect(missing).toEqual([]);
  });
});
