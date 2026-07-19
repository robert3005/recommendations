/**
 * Golden tests for the export writers (book/src/interop.md §Export): exact
 * output for a fixed list — an OSM-linked place with evidence and an imported
 * unlinked pin with an external ref. ODbL attribution appears exactly when
 * OSM-derived facts are present; the CSV keeps the Takeout shape and
 * round-trips through our own CSV parser.
 */
import type { List, Note, Place } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { exportListCsv, exportListGeoJson, exportListGpx, exportListKml } from "./export";
import { parseSavedCsv } from "./parse";

const NOW = "2026-07-18T12:00:00.000Z";

const list: List = {
  id: "list-1",
  name: "Lisbon <trip>",
  color: "#dc2626",
  createdAt: NOW,
  updatedAt: NOW,
};

const linked: Place = {
  id: "p1",
  origin: "osm",
  currentOsmRef: { type: "node", id: "101" },
  currentOsmLinkedAt: NOW,
  osmRefHistory: [],
  lastVerified: {
    ref: { type: "node", id: "101" },
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    address: "Rua Example 12, Lisboa",
    website: "https://cafecentral.example",
    identityTags: {},
    observedAt: NOW,
  },
  resolutionState: "resolved",
  createdAt: NOW,
  updatedAt: NOW,
};

const imported: Place = {
  id: "p2",
  origin: "import",
  osmRefHistory: [],
  manual: { name: "Dropped pin", lat: 38.71, lng: -9.15 },
  externalRefs: [
    {
      provider: "google-maps",
      url: "https://www.google.com/maps/search/38.71,-9.15",
      importedAt: NOW,
    },
  ],
  resolutionState: "unlinked",
  createdAt: NOW,
  updatedAt: NOW,
};

const note: Note = {
  id: "n1",
  target: { kind: "place", placeId: "p1" },
  body: "Great bica, sit outside",
  mediaIds: [],
  shareable: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const views = [
  { place: linked, notes: [note] },
  { place: imported, notes: [] },
];

describe("export writers", () => {
  it("KML carries the list marker colour, descriptions, and ODbL attribution", () => {
    expect(exportListKml(list, views)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Lisbon &lt;trip&gt;</name>
    <description>Contains OSM-derived data © OpenStreetMap contributors, ODbL 1.0 (opendatacommons.org/licenses/odbl/1-0/)</description>
    <Style id="marker"><IconStyle><color>ff2626dc</color></IconStyle></Style>
    <Placemark>
      <name>Café Central</name>
      <description>Rua Example 12, Lisboa

Great bica, sit outside</description>
      <styleUrl>#marker</styleUrl>
      <Point><coordinates>-9.1394,38.7139</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Dropped pin</name>
      <styleUrl>#marker</styleUrl>
      <Point><coordinates>-9.15,38.71</coordinates></Point>
    </Placemark>
  </Document>
</kml>
`,
    );
  });

  it("CSV keeps the Takeout columns first and round-trips through our importer", () => {
    const csv = exportListCsv(list, views);
    expect(csv).toBe(
      `Title,Note,URL,Address,Attribution
Café Central,"Great bica, sit outside",https://www.openstreetmap.org/node/101,"Rua Example 12, Lisboa","Contains OSM-derived data © OpenStreetMap contributors, ODbL 1.0 (opendatacommons.org/licenses/odbl/1-0/)"
Dropped pin,,"https://www.google.com/maps/search/38.71,-9.15",,
`,
    );
    const reparsed = parseSavedCsv(csv, "Round trip");
    expect(reparsed.items).toHaveLength(2);
    expect(reparsed.items[1]?.coords).toEqual({ lat: 38.71, lng: -9.15 });
    expect(reparsed.unusable).toHaveLength(0);
  });

  it("GeoJSON carries refs, notes, and attribution as metadata", () => {
    const parsed = JSON.parse(exportListGeoJson(list, views)) as {
      attribution?: string;
      features: { properties: Record<string, unknown> }[];
    };
    expect(parsed.attribution).toMatch(/ODbL/);
    expect(parsed.features[0]?.properties).toMatchObject({
      name: "Café Central",
      osmRef: "node/101",
      note: "Great bica, sit outside",
      website: "https://cafecentral.example",
    });
    expect(parsed.features[1]?.properties.externalUrls).toEqual([
      "https://www.google.com/maps/search/38.71,-9.15",
    ]);
  });

  it("GPX emits waypoints with an ODbL copyright block", () => {
    expect(exportListGpx(list, views)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Placemarks" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Lisbon &lt;trip&gt;</name>
    <copyright author="OpenStreetMap contributors">
      <license>https://opendatacommons.org/licenses/odbl/1-0/</license>
    </copyright>
  </metadata>
  <wpt lat="38.7139" lon="-9.1394">
    <name>Café Central</name>
    <desc>Rua Example 12, Lisboa

Great bica, sit outside</desc>
  </wpt>
  <wpt lat="38.71" lon="-9.15">
    <name>Dropped pin</name>
  </wpt>
</gpx>
`,
    );
  });

  it("attribution disappears when nothing is OSM-derived", () => {
    const unlinkedOnly = [{ place: imported, notes: [] }];
    expect(exportListKml(list, unlinkedOnly)).not.toContain("ODbL");
    expect(exportListGpx(list, unlinkedOnly)).not.toContain("copyright");
    expect(exportListGeoJson(list, unlinkedOnly)).not.toContain("attribution");
  });
});
