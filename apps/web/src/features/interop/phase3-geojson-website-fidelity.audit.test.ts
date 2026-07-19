/**
 * GeoJSON is the Phase 3 full-fidelity interchange format
 * (spec/src/interop.md). A field emitted by our writer must survive its parser.
 */
import { createOsmPlace, type List, type ResolvedPoi } from "@placemarks/domain";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { exportListGeoJson } from "./export";
import { parseImportFile } from "./parse";

describe("Phase 3 GeoJSON website fidelity", () => {
  it("retains an exported place website when the GeoJSON is imported again", async () => {
    const website = "https://cafe.example/menu";
    const now = "2026-07-19T12:00:00.000Z";
    const list: List = { id: "list-1", name: "Round trip", createdAt: now, updatedAt: now };
    const poi: ResolvedPoi = {
      osmRef: { type: "node", id: "101" },
      name: "Café Central",
      category: "cafe",
      lat: 38.7139,
      lng: -9.1394,
      website,
      identityTags: { name: "Café Central", amenity: "cafe", website },
      resolvedAt: now,
    };
    const geojson = exportListGeoJson(list, [
      { place: createOsmPlace("place-1", poi, now), notes: [] },
    ]);

    const parsed = await parseImportFile({
      name: "round-trip.geojson",
      bytes: strToU8(geojson),
    });
    const item = parsed.lists[0]?.items[0] as Record<string, unknown> | undefined;

    expect(item).toMatchObject({ website });
  });
});
