/**
 * Golden tests for the export writers (spec/src/interop.md §Testing): exact
 * output for a fixed list — an OSM-linked place and an unlinked imported pin.
 * Marker styling travels (KML style + simplestyle, shape name as a property);
 * ODbL attribution appears exactly when `osmRef` is present.
 */
import type { List, Place } from "@placemarks/domain";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  exportListGeoJson,
  exportListGpx,
  exportListKml,
  exportListKmz,
  exportListMarkdown,
  MY_MAPS_LAYER_LIMIT,
  splitForMyMaps,
} from "./export";

const NOW = "2026-07-26T12:00:00.000Z";
const PLACE_URL =
  "https://www.google.com/maps/place/Caf%C3%A9+Central/data=!4m2!3m1!1s0x1f9a2b:0xdeadbeef";

const list: List = {
  id: "list-1",
  name: "Lisbon <trip>",
  marker: { shape: "star", color: "#17A34A" },
  createdAt: NOW,
  updatedAt: NOW,
};

const linked: Place = {
  id: "p1",
  name: "Café Central",
  lat: 38.7139,
  lng: -9.1394,
  address: "Rua Example 12, Lisboa",
  category: "cafe",
  origin: "osm",
  googleUrl: PLACE_URL,
  osmRef: { type: "node", id: "101" },
  createdAt: NOW,
  updatedAt: NOW,
};

const unlinked: Place = {
  id: "p2",
  name: "Dropped pin",
  lat: 38.71,
  lng: -9.15,
  origin: "takeout",
  createdAt: NOW,
  updatedAt: NOW,
};

const places = [linked, unlinked];

describe("export writers", () => {
  it("KML carries the marker colour, the shape name in the style id, and ODbL attribution", () => {
    expect(exportListKml(list, places)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Lisbon &lt;trip&gt;</name>
    <description>Contains OSM-derived data © OpenStreetMap contributors, ODbL 1.0 (opendatacommons.org/licenses/odbl/1-0/)</description>
    <Style id="placemarks-star"><IconStyle><color>ff4aa317</color></IconStyle></Style>
    <Placemark>
      <name>Café Central</name>
      <description>Rua Example 12, Lisboa</description>
      <styleUrl>#placemarks-star</styleUrl>
      <Point><coordinates>-9.1394,38.7139</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Dropped pin</name>
      <styleUrl>#placemarks-star</styleUrl>
      <Point><coordinates>-9.15,38.71</coordinates></Point>
    </Placemark>
  </Document>
</kml>
`,
    );
  });

  it("KMZ is the same KML zipped as doc.kml", () => {
    const entries = unzipSync(exportListKmz(list, places));
    expect(Object.keys(entries)).toEqual(["doc.kml"]);
    const docKml = entries["doc.kml"];
    expect(docKml).toBeDefined();
    expect(strFromU8(docKml as Uint8Array)).toBe(exportListKml(list, places));
  });

  it("GeoJSON writes simplestyle marker properties and attribution as metadata", () => {
    expect(exportListGeoJson(list, places)).toBe(
      `{
  "type": "FeatureCollection",
  "name": "Lisbon <trip>",
  "attribution": "Contains OSM-derived data © OpenStreetMap contributors, ODbL 1.0 (opendatacommons.org/licenses/odbl/1-0/)",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [
          -9.1394,
          38.7139
        ]
      },
      "properties": {
        "name": "Café Central",
        "category": "cafe",
        "address": "Rua Example 12, Lisboa",
        "marker-color": "#17A34A",
        "marker-symbol": "star",
        "osmRef": "node/101",
        "googleUrl": "${PLACE_URL}"
      }
    },
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [
          -9.15,
          38.71
        ]
      },
      "properties": {
        "name": "Dropped pin",
        "marker-color": "#17A34A",
        "marker-symbol": "star"
      }
    }
  ]
}
`,
    );
  });

  it("GPX emits waypoints with an ODbL copyright block", () => {
    expect(exportListGpx(list, places)).toBe(
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
    <desc>Rua Example 12, Lisboa</desc>
  </wpt>
  <wpt lat="38.71" lon="-9.15">
    <name>Dropped pin</name>
  </wpt>
</gpx>
`,
    );
  });

  it("the text list hands out all three deep links per place, via domain links", () => {
    expect(exportListMarkdown(list, places)).toBe(
      `# Lisbon <trip>

## Café Central

cafe · Rua Example 12, Lisboa

[Google Maps](${PLACE_URL}) · [Apple Maps](https://maps.apple.com/?ll=38.7139,-9.1394&q=Caf%C3%A9%20Central) · [OpenStreetMap](https://www.openstreetmap.org/node/101)

## Dropped pin

[Google Maps](https://www.google.com/maps/search/?api=1&query=Dropped%20pin%2038.71%2C-9.15) · [Apple Maps](https://maps.apple.com/?ll=38.71,-9.15&q=Dropped%20pin) · [OpenStreetMap](https://www.openstreetmap.org/?mlat=38.71&mlon=-9.15)

---

Contains OSM-derived data © OpenStreetMap contributors, ODbL 1.0 (opendatacommons.org/licenses/odbl/1-0/)
`,
    );
  });

  it("attribution disappears when nothing carries an osmRef", () => {
    const unlinkedOnly = [unlinked];
    expect(exportListKml(list, unlinkedOnly)).not.toContain("ODbL");
    expect(exportListGpx(list, unlinkedOnly)).not.toContain("copyright");
    expect(exportListGeoJson(list, unlinkedOnly)).not.toContain("attribution");
    expect(exportListMarkdown(list, unlinkedOnly)).not.toContain("ODbL");
  });

  it("the My Maps handoff splits along the 2,000-feature layer limit", () => {
    const many: Place[] = Array.from({ length: MY_MAPS_LAYER_LIMIT + 1 }, (_, i) => ({
      ...unlinked,
      id: `p-${i.toString()}`,
      name: `Place ${i.toString()}`,
    }));
    const chunks = splitForMyMaps(list, many);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(MY_MAPS_LAYER_LIMIT);
    expect(chunks[1]?.length).toBe(1);
    expect(splitForMyMaps(list, places)).toEqual([places]);
  });
});
