/**
 * List export writers (spec/src/interop.md §Export): KML/KMZ (Google My Maps
 * ingests it), GeoJSON simplestyle (uMap ingests it), GPX waypoints (OsmAnd,
 * Organic Maps), and the deep-link text list — the paste-into-a-message shape.
 * Pure string builders — golden-snapshot tested. Marker styling travels: KML
 * styles and simplestyle properties carry the list's marker colour, and the
 * shape name rides as a property where the format allows. Exports attribute
 * OSM (ODbL) exactly when `osmRef` is present.
 */
import {
  appleLink,
  googleLink,
  type List,
  osmLink,
  osmRefKey,
  type Place,
} from "@placemarks/domain";
import { strToU8, zipSync } from "fflate";

const OSM_ATTRIBUTION_TEXT =
  "Contains OSM-derived data © OpenStreetMap contributors, ODbL 1.0 (opendatacommons.org/licenses/odbl/1-0/)";

const hasOsmDerived = (places: Place[]): boolean => places.some((p) => p.osmRef !== undefined);

function xmlEscape(value: string): string {
  return (
    value
      // Control characters are unrepresentable in XML 1.0 — strip, don't escape.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
  );
}

/** #rrggbb → KML's aabbggrr. */
function kmlColor(hex: string): string {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return "ffffffff";
  return `ff${match[3]}${match[2]}${match[1]}`.toLowerCase();
}

export function exportListKml(list: List, places: Place[]): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<kml xmlns="http://www.opengis.net/kml/2.2">`,
    `  <Document>`,
    `    <name>${xmlEscape(list.name)}</name>`,
  ];
  if (hasOsmDerived(places)) {
    lines.push(`    <description>${xmlEscape(OSM_ATTRIBUTION_TEXT)}</description>`);
  }
  // The style carries the marker colour; the style id carries the shape name —
  // the property slot KML allows (spec/src/interop.md §Export).
  lines.push(
    `    <Style id="placemarks-${list.marker.shape}"><IconStyle><color>${kmlColor(
      list.marker.color,
    )}</color></IconStyle></Style>`,
  );
  for (const place of places) {
    lines.push(
      `    <Placemark>`,
      `      <name>${xmlEscape(place.name)}</name>`,
      ...(place.address ? [`      <description>${xmlEscape(place.address)}</description>`] : []),
      `      <styleUrl>#placemarks-${list.marker.shape}</styleUrl>`,
      `      <Point><coordinates>${place.lng},${place.lat}</coordinates></Point>`,
      `    </Placemark>`,
    );
  }
  lines.push(`  </Document>`, `</kml>`, ``);
  return lines.join("\n");
}

/** KMZ: the KML zipped as doc.kml — what Google Earth/My Maps also accept. */
export function exportListKmz(list: List, places: Place[]): Uint8Array {
  return zipSync({ "doc.kml": strToU8(exportListKml(list, places)) });
}

export function exportListGeoJson(list: List, places: Place[]): string {
  const collection = {
    type: "FeatureCollection",
    name: list.name,
    ...(hasOsmDerived(places) ? { attribution: OSM_ATTRIBUTION_TEXT } : {}),
    features: places.map((place) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [place.lng, place.lat] },
      properties: {
        name: place.name,
        ...(place.category ? { category: place.category } : {}),
        ...(place.address ? { address: place.address } : {}),
        // simplestyle: the marker colour travels; the shape name rides as the symbol.
        "marker-color": list.marker.color,
        "marker-symbol": list.marker.shape,
        ...(place.osmRef ? { osmRef: osmRefKey(place.osmRef) } : {}),
        ...(place.googleUrl ? { googleUrl: place.googleUrl } : {}),
      },
    })),
  };
  return `${JSON.stringify(collection, null, 2)}\n`;
}

/** GPX waypoints — what OsmAnd and Organic Maps ingest (spec/src/interop.md §Export). */
export function exportListGpx(list: List, places: Place[]): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="Placemarks" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <metadata>`,
    `    <name>${xmlEscape(list.name)}</name>`,
  ];
  if (hasOsmDerived(places)) {
    lines.push(
      `    <copyright author="OpenStreetMap contributors">`,
      `      <license>https://opendatacommons.org/licenses/odbl/1-0/</license>`,
      `    </copyright>`,
    );
  }
  lines.push(`  </metadata>`);
  for (const place of places) {
    lines.push(
      `  <wpt lat="${place.lat}" lon="${place.lng}">`,
      `    <name>${xmlEscape(place.name)}</name>`,
      ...(place.address ? [`    <desc>${xmlEscape(place.address)}</desc>`] : []),
      `  </wpt>`,
    );
  }
  lines.push(`</gpx>`, ``);
  return lines.join("\n");
}

/**
 * The deep-link text list (Markdown): the list as prose — name, address, and
 * all three deep links per place — the artefact to paste into a message. One
 * module (domain links) builds every URL, so the place card, these exports,
 * and the public viewer hand out the same links.
 */
export function exportListMarkdown(list: List, places: Place[]): string {
  const lines: string[] = [`# ${list.name}`, ""];
  for (const place of places) {
    lines.push(`## ${place.name}`, "");
    const subtitle = [place.category, place.address].filter(Boolean).join(" · ");
    if (subtitle) lines.push(subtitle, "");
    lines.push(
      [
        `[Google Maps](${googleLink(place)})`,
        `[Apple Maps](${appleLink(place)})`,
        `[OpenStreetMap](${osmLink(place)})`,
      ].join(" · "),
      "",
    );
  }
  if (hasOsmDerived(places)) lines.push("---", "", OSM_ATTRIBUTION_TEXT, "");
  return lines.join("\n");
}

// ---------- Guided handoffs (spec/src/interop.md §Export) ----------

/** My Maps accepts ≤2,000 features per layer AND ≤5 MB per file. */
export const MY_MAPS_LAYER_LIMIT = 2000;
export const MY_MAPS_FILE_BYTE_LIMIT = 5 * 1024 * 1024;

export const MY_MAPS_HANDOFF =
  "Google My Maps accepts up to 2,000 features per layer and 5 MB per file — larger lists split " +
  "into numbered parts automatically. Then: Google My Maps → Create a new map → Import → choose this file.";

export const UMAP_HANDOFF =
  "On umap.openstreetmap.fr: Create a map → Import data, choose this GeoJSON (or KML) file, and " +
  "confirm the import. The list's marker colour rides along.";

/**
 * Split a list for the My Maps handoff along whichever limit binds first.
 * Parts are measured with the longest part-suffixed name they could carry.
 */
export function splitForMyMaps(list: List, places: Place[]): Place[][] {
  const byCount: Place[][] = [];
  for (let i = 0; i < places.length; i += MY_MAPS_LAYER_LIMIT) {
    byCount.push(places.slice(i, i + MY_MAPS_LAYER_LIMIT));
  }
  if (byCount.length === 0) byCount.push([]);
  const chunks: Place[][] = [];
  const fits = (chunk: Place[]): boolean =>
    new TextEncoder().encode(exportListKml({ ...list, name: `${list.name} (part 999)` }, chunk))
      .byteLength <= MY_MAPS_FILE_BYTE_LIMIT;
  const bySize = (chunk: Place[]): void => {
    if (fits(chunk)) {
      chunks.push(chunk);
      return;
    }
    if (chunk.length <= 1) {
      // A single feature cannot be split — refusing beats emitting a file My Maps will reject.
      throw new Error("one place exceeds the 5 MB My Maps file limit");
    }
    const mid = Math.ceil(chunk.length / 2);
    bySize(chunk.slice(0, mid));
    bySize(chunk.slice(mid));
  };
  for (const chunk of byCount) bySize(chunk);
  return chunks;
}
