/**
 * KML source styles become list marker colours (spec/src/interop.md).
 * StyleMap's normal style is the resting marker, and loose document-level
 * placemarks keep their own style when folders are present beside them.
 */
import { describe, expect, it } from "vitest";
import { parseKml } from "./parse";

describe("Phase 3 KML style fidelity", () => {
  it("uses the normal StyleMap pair even when highlight is declared first", () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Style id="highlight"><IconStyle><color>ffff0000</color></IconStyle></Style>
  <Style id="normal"><IconStyle><color>ff0000ff</color></IconStyle></Style>
  <StyleMap id="marker-map">
    <Pair><key>highlight</key><styleUrl>#highlight</styleUrl></Pair>
    <Pair><key>normal</key><styleUrl>#normal</styleUrl></Pair>
  </StyleMap>
  <Folder><name>Food</name>
    <Placemark><name>Café</name><styleUrl>#marker-map</styleUrl>
      <Point><coordinates>-9.1,38.7</coordinates></Point>
    </Placemark>
  </Folder>
</Document></kml>`;

    expect(parseKml(kml, "fallback")[0]?.color).toBe("#ff0000");
  });

  it("retains the style of a document-level placemark beside styled folders", () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Mixed trip</name>
  <Style id="folder-blue"><IconStyle><color>ffff0000</color></IconStyle></Style>
  <Style id="loose-red"><IconStyle><color>ff0000ff</color></IconStyle></Style>
  <Folder><name>Views</name>
    <Placemark><name>Miradouro</name><styleUrl>#folder-blue</styleUrl>
      <Point><coordinates>-9.2,38.8</coordinates></Point>
    </Placemark>
  </Folder>
  <Placemark><name>Loose café</name><styleUrl>#loose-red</styleUrl>
    <Point><coordinates>-9.1,38.7</coordinates></Point>
  </Placemark>
</Document></kml>`;

    const lists = parseKml(kml, "fallback");
    expect(lists.find((list) => list.name === "Mixed trip")?.color).toBe("#ff0000");
    expect(lists.find((list) => list.name === "Views")?.color).toBe("#0000ff");
  });
});
