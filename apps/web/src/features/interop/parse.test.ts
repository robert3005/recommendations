/**
 * Parser fixtures shaped like real Takeout archives (spec/src/interop.md
 * §Testing): CSV quoting edge cases, Unicode list names, dropped-pin URLs
 * beside place URLs, the [0, 0] GeoJSON bug, KML folders with styles — and
 * the removal of the GPX/GeoJSON import paths.
 */
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  droppedPinCoords,
  parseImportFile,
  parseKml,
  parseSavedCsv,
  parseTakeoutZip,
  SAVED_PLACES_LIST_NAME,
} from "./parse";

const PLACE_URL =
  "https://www.google.com/maps/place/Caf%C3%A9+Central/data=!4m2!3m1!1s0x1f9a2b:0xdeadbeef";
const PIN_URL = "https://www.google.com/maps/search/38.71000,-9.15000";

describe("droppedPinCoords", () => {
  it("reads literal coordinates from dropped-pin URLs only", () => {
    expect(droppedPinCoords(PIN_URL)).toEqual({ lat: 38.71, lng: -9.15 });
    expect(droppedPinCoords("https://maps.google.com/?q=38.7,-9.1")).toEqual({
      lat: 38.7,
      lng: -9.1,
    });
    // Out of range is not a coordinate.
    expect(droppedPinCoords("https://www.google.com/maps/search/91.0,-9.1")).toBeUndefined();
    // A place URL's @camera is where the map happened to be — never rung 1.
    expect(droppedPinCoords("https://www.google.com/maps/place/X/@38.7,-9.1,15z")).toBeUndefined();
    expect(droppedPinCoords(PLACE_URL)).toBeUndefined();
  });
});

describe("parseSavedCsv", () => {
  it("parses quoted rows, keeps notes verbatim, and accounts for unusable rows", () => {
    const csv = [
      "Title,Note,URL,Address",
      `"Café Central","Great bica,  sit outside ","${PLACE_URL}","Rua Example 12, Lisboa"`,
      `,"row without a title",,`,
    ].join("\n");
    const parsed = parseSavedCsv(csv, "Lisbon trip", "Lisbon trip.csv");
    expect(parsed.sourceKey).toBe("Lisbon trip.csv");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toEqual({
      title: "Café Central",
      note: "Great bica,  sit outside ",
      url: PLACE_URL,
      address: "Rua Example 12, Lisboa",
    });
    expect(parsed.unusable).toHaveLength(1);
    expect(parsed.unusable[0]?.note).toBe("row without a title");
  });

  it("repairs an unquoted dropped-pin URL split across columns", () => {
    const csv = [
      "Title,Note,URL,Address",
      `Dropped pin,,https://www.google.com/maps/search/38.71,-9.15,`,
    ].join("\n");
    const parsed = parseSavedCsv(csv, "Pins");
    expect(parsed.items[0]?.url).toBe("https://www.google.com/maps/search/38.71,-9.15");
    expect(parsed.items[0]?.coords).toEqual({ lat: 38.71, lng: -9.15 });
    expect(parsed.items[0]?.address).toBeUndefined();
  });
});

describe("parseTakeoutZip", () => {
  const savedPlaces = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-9.1394, 38.7139] },
        properties: { Title: "Café Central", "Google Maps URL": PLACE_URL },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { Title: "Zero Island", "Google Maps URL": "https://maps.google.com/?cid=9" },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-9.2, 38.8] },
        properties: { Title: "Geo Only", "Google Maps URL": "https://maps.google.com/?cid=777" },
      },
    ],
  };

  it("joins CSV rows to geometry by feature id, honours the [0,0] bug, and keeps leftovers", () => {
    const zip = zipSync({
      "Takeout/Saved/Cafés în Łódź.csv": strToU8(
        `Title,Note,URL,Address\n"Café Central",,"${PLACE_URL}",\n"Zero Island",,"https://maps.google.com/?cid=9",\n`,
      ),
      "Takeout/Maps (your places)/Saved Places.json": strToU8(JSON.stringify(savedPlaces)),
    });
    const parsed = parseTakeoutZip(zip);
    expect(parsed.source).toBe("takeout");
    expect(parsed.lists).toHaveLength(2);

    const csvList = parsed.lists[0];
    expect(csvList?.name).toBe("Cafés în Łódź");
    expect(csvList?.sourceKey).toBe("Cafés în Łódź.csv");
    const [central, zero] = csvList?.items ?? [];
    expect(central?.coords).toEqual({ lat: 38.7139, lng: -9.1394 });
    expect(zero?.coords).toBeUndefined(); // the [0,0] bug must not place a row

    // Geometry no CSV references becomes the auto "Saved places" list, bound
    // to the GeoJSON filename.
    const leftovers = parsed.lists[1];
    expect(leftovers?.name).toBe(SAVED_PLACES_LIST_NAME);
    expect(leftovers?.sourceKey).toBe("Saved Places.json");
    expect(leftovers?.items.map((i) => i.title)).toEqual(["Geo Only"]);
  });

  it("refuses an archive with no recognized entries", () => {
    const zip = zipSync({ "Takeout/Mail/inbox.mbox": strToU8("nope") });
    expect(() => parseTakeoutZip(zip)).toThrow(/no recognized Takeout entries/);
  });
});

describe("parseKml", () => {
  const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Portugal</name>
    <Style id="icon-1899-DB4436"><IconStyle><color>ff3644db</color></IconStyle></Style>
    <StyleMap id="mapped">
      <Pair><key>highlight</key><styleUrl>#icon-1899-DB4436</styleUrl></Pair>
      <Pair><key>normal</key><styleUrl>#icon-green</styleUrl></Pair>
    </StyleMap>
    <Style id="icon-green"><IconStyle><color>ff4aa317</color></IconStyle></Style>
    <Folder id="folder-1">
      <name>Cafés</name>
      <Placemark>
        <name>Café Central</name>
        <description>the good bica</description>
        <styleUrl>#icon-1899-DB4436</styleUrl>
        <Point><coordinates>-9.1394,38.7139,0</coordinates></Point>
      </Placemark>
    </Folder>
    <Folder>
      <name>Viewpoints</name>
      <Placemark>
        <name>Miradouro</name>
        <styleUrl>#mapped</styleUrl>
        <Point><coordinates>-9.13,38.71,0</coordinates></Point>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

  it("folders become lists with their style colour and a folder-id binding", () => {
    const lists = parseKml(KML, "portugal");
    expect(lists).toHaveLength(2);
    expect(lists[0]).toMatchObject({
      name: "Cafés",
      sourceKey: "folder-1",
      color: "#db4436",
    });
    expect(lists[0]?.items[0]).toEqual({
      title: "Café Central",
      note: "the good bica",
      coords: { lat: 38.7139, lng: -9.1394 },
    });
    // A StyleMap resolves through its NORMAL pair, whatever the declared order.
    expect(lists[1]).toMatchObject({
      name: "Viewpoints",
      sourceKey: "Viewpoints",
      color: "#17a34a",
    });
  });

  it("a folderless document stays one list named by the document", () => {
    const flat = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Flat</name>
  <Placemark><name>Solo</name><Point><coordinates>-9.1,38.7,0</coordinates></Point></Placemark>
</Document></kml>`;
    const lists = parseKml(flat, "fallback");
    expect(lists).toHaveLength(1);
    expect(lists[0]?.name).toBe("Flat");
    expect(lists[0]?.items).toHaveLength(1);
  });
});

describe("parseImportFile", () => {
  it("routes zip/csv/json to takeout and kml/kmz to mymaps-kml", async () => {
    const csv = await parseImportFile({
      name: "Lisbon trip.csv",
      bytes: strToU8("Title,Note,URL,Address\nSolo,,,\n"),
    });
    expect(csv.source).toBe("takeout");
    expect(csv.lists[0]).toMatchObject({ name: "Lisbon trip", sourceKey: "Lisbon trip.csv" });

    const json = await parseImportFile({
      name: "Saved Places.json",
      bytes: strToU8(
        JSON.stringify({
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [-9.2, 38.8] },
              properties: { Title: "Geo Only" },
            },
          ],
        }),
      ),
    });
    expect(json.source).toBe("takeout");
    expect(json.lists[0]).toMatchObject({
      name: SAVED_PLACES_LIST_NAME,
      sourceKey: "Saved Places.json",
    });

    const kmz = await parseImportFile({
      name: "map.kmz",
      bytes: zipSync({
        "doc.kml": strToU8(
          `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Map</name><Placemark><name>Solo</name><Point><coordinates>-9.1,38.7,0</coordinates></Point></Placemark></Document></kml>`,
        ),
      }),
    });
    expect(kmz.source).toBe("mymaps-kml");
  });

  it("refuses GPX and GeoJSON — they are export-only now", async () => {
    await expect(parseImportFile({ name: "trip.gpx", bytes: strToU8("<gpx/>") })).rejects.toThrow(
      /unsupported import file/,
    );
    await expect(parseImportFile({ name: "trip.geojson", bytes: strToU8("{}") })).rejects.toThrow(
      /unsupported import file/,
    );
  });
});
