/** GeoJSON is the full-fidelity Phase 3 interchange, including list identity. */
import { type List, markerAt, type Place } from "@placemarks/domain";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { exportListGeoJson } from "./export";
import { parseImportFile } from "./parse";

const NOW = "2026-07-19T12:00:00.000Z";

describe("Phase 3 GeoJSON list-name fidelity", () => {
  it("uses the exported FeatureCollection name instead of the download filename", async () => {
    const list: List = {
      id: "list",
      name: "Cafés & caminhadas 🌊",
      marker: markerAt(0),
      createdAt: NOW,
      updatedAt: NOW,
    };
    const place: Place = {
      id: "place",
      origin: "import",
      pastOsmRefs: [],
      manual: { name: "Miradouro", lat: 38.7139, lng: -9.1394 },
      resolutionState: "unlinked",
      createdAt: NOW,
      updatedAt: NOW,
    };

    const exported = exportListGeoJson(list, [{ place, notes: [] }]);
    const parsed = await parseImportFile({
      name: "sanitized-download-name.geojson",
      bytes: strToU8(exported),
    });

    expect(parsed.lists[0]?.name).toBe(list.name);
  });
});
