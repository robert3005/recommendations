/**
 * List export writers (spec/src/interop.md §Export): KML (Google My Maps
 * ingests it), Takeout-shaped CSV (round-trips through our own importer),
 * GeoJSON, GPX waypoints, and a Markdown list of places with their deep links —
 * the paste-into-a-message shape. Pure string builders — golden-snapshot tested.
 * Exports containing OSM-derived facts carry ODbL attribution where the format
 * has a metadata slot (KML/GeoJSON/GPX); the CSV keeps the exact Takeout shape.
 */
import {
  type DisplayFacts,
  displayFacts,
  type List,
  type Note,
  osmElementUrl,
  type Place,
  type Tag,
} from "@placemarks/domain";
import { strToU8, zipSync } from "fflate";
import Papa from "papaparse";
import { DEFAULT_PIN_COLOR } from "../../lib/markers";
import { placeLinksFor } from "./placeLinks";

export interface ExportPlaceView {
  place: Place;
  notes: Note[];
  tags?: Tag[];
}

const OSM_ATTRIBUTION_TEXT =
  "Contains OSM-derived data © OpenStreetMap contributors, ODbL 1.0 (opendatacommons.org/licenses/odbl/1-0/)";

interface ExportRow {
  facts: DisplayFacts;
  place: Place;
  note?: string;
  tags: string[];
}

function rows(views: ExportPlaceView[]): ExportRow[] {
  const out: ExportRow[] = [];
  for (const view of views) {
    const facts = displayFacts(view.place);
    if (!facts) continue;
    // Markdown whitespace is significant (code blocks) — never trimmed.
    const note = view.notes
      .map((n) => n.body)
      .filter((body) => body.trim() !== "")
      .join("\n\n");
    out.push({
      facts,
      place: view.place,
      ...(note ? { note } : {}),
      tags: (view.tags ?? []).map((t) => t.name),
    });
  }
  return out;
}

/** OSM provenance survives an unresolved binding: history counts, not just live evidence. */
const osmDerived = (place: ExportPlaceView["place"]): boolean =>
  place.lastVerified !== undefined ||
  place.firstSeen !== undefined ||
  place.currentOsmRef !== undefined ||
  place.pastOsmRefs.length > 0;

const hasOsmDerived = (views: ExportPlaceView[]): boolean => views.some((v) => osmDerived(v.place));

/** The OSM element the place's facts descend from — its current binding, or a former one. */
function sourceRefOf(place: ExportPlaceView["place"]): string | undefined {
  const ref = place.currentOsmRef ?? place.pastOsmRefs[place.pastOsmRefs.length - 1];
  return ref ? `${ref.type}/${ref.id}` : undefined;
}

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
function kmlColor(hex: string | undefined): string {
  const match = (hex ?? DEFAULT_PIN_COLOR).match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return "ffffffff";
  return `ff${match[3]}${match[2]}${match[1]}`.toLowerCase();
}

export function exportListKml(list: List, views: ExportPlaceView[]): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<kml xmlns="http://www.opengis.net/kml/2.2">`,
    `  <Document>`,
    `    <name>${xmlEscape(list.name)}</name>`,
  ];
  if (hasOsmDerived(views)) {
    lines.push(`    <description>${xmlEscape(OSM_ATTRIBUTION_TEXT)}</description>`);
  }
  // The style id carries the marker icon (`placemarks-<icon>`) so our own
  // exports round-trip the full (colour, icon) marker; foreign consumers just
  // see a normal coloured style (spec/src/roadmap.md Phase 6).
  lines.push(
    `    <Style id="placemarks-${list.marker.icon}"><IconStyle><color>${kmlColor(
      list.marker.color,
    )}</color></IconStyle></Style>`,
  );
  for (const row of rows(views)) {
    const description = [row.facts.address, row.note].filter(Boolean).join("\n\n");
    lines.push(
      `    <Placemark>`,
      `      <name>${xmlEscape(row.facts.name ?? "Unnamed place")}</name>`,
      ...(description ? [`      <description>${xmlEscape(description)}</description>`] : []),
      `      <styleUrl>#placemarks-${list.marker.icon}</styleUrl>`,
      `      <Point><coordinates>${row.facts.lng},${row.facts.lat}</coordinates></Point>`,
      `    </Placemark>`,
    );
  }
  lines.push(`  </Document>`, `</kml>`, ``);
  return lines.join("\n");
}

/** The retained Google listing, when the place was imported or added from a link. */
function googleListingUrl(place: Place): string | undefined {
  return place.externalRefs?.find((ref) => ref.provider === "google-maps")?.url;
}

/** The URL column mirrors import provenance: external ref, else OSM portal, else coordinates. */
function urlFor(row: ExportRow): string {
  // A retained Google listing is the deep link back — it outranks whichever
  // generic web ref happened to be stored first.
  const external = googleListingUrl(row.place) ?? row.place.externalRefs?.[0]?.url;
  if (external) return external;
  if (row.place.currentOsmRef) return osmElementUrl(row.place.currentOsmRef);
  return `https://www.google.com/maps/search/?api=1&query=${row.facts.lat},${row.facts.lng}`;
}

/** Spreadsheets execute cells starting with = + - @ (even after trimming) — quote defensively. */
function formulaEscape(value: string): string {
  return /^[\s\r\t]*[=+\-@]/.test(value) ? `'${value}` : value;
}

export function exportListCsv(_list: List, views: ExportPlaceView[]): string {
  // The Takeout columns stay first so the file round-trips through Takeout
  // parsers (ours included); the extra Attribution column carries ODbL credit
  // for rows whose facts are OSM-derived (spec/src/interop.md).
  return `${Papa.unparse(
    {
      fields: ["Title", "Note", "URL", "Address", "Attribution"],
      data: rows(views).map((row) => [
        formulaEscape(row.facts.name ?? "Unnamed place"),
        formulaEscape(row.note ?? ""),
        urlFor(row),
        formulaEscape(row.facts.address ?? ""),
        osmDerived(row.place)
          ? `${OSM_ATTRIBUTION_TEXT}${sourceRefOf(row.place) ? ` — source ${sourceRefOf(row.place) ?? ""}` : ""}`
          : "",
      ]),
    },
    { newline: "\n" },
  )}\n`;
}

export function exportListGeoJson(list: List, views: ExportPlaceView[]): string {
  const collection = {
    type: "FeatureCollection",
    name: list.name,
    ...(hasOsmDerived(views) ? { attribution: OSM_ATTRIBUTION_TEXT } : {}),
    features: rows(views).map((row) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [row.facts.lng, row.facts.lat] },
      properties: {
        name: row.facts.name ?? "Unnamed place",
        ...(row.facts.category ? { category: row.facts.category } : {}),
        ...(row.facts.address ? { address: row.facts.address } : {}),
        ...(row.facts.website ? { website: row.facts.website } : {}),
        ...(row.facts.phone ? { phone: row.facts.phone } : {}),
        ...(row.facts.openingHours ? { openingHours: row.facts.openingHours } : {}),
        ...(row.tags.length > 0 ? { tags: row.tags } : {}),
        ...(row.note ? { note: row.note } : {}),
        ...(sourceRefOf(row.place) ? { osmRef: sourceRefOf(row.place) } : {}),
        ...(row.place.externalRefs?.length
          ? { externalUrls: row.place.externalRefs.map((r) => r.url) }
          : {}),
      },
    })),
  };
  return `${JSON.stringify(collection, null, 2)}\n`;
}

/** KMZ: the KML zipped as doc.kml — what Google Earth/My Maps also accept. */
export function exportListKmz(list: List, views: ExportPlaceView[]): Uint8Array {
  return zipSync({ "doc.kml": strToU8(exportListKml(list, views)) });
}

/**
 * A readable list of places, each with the three deep links.
 *
 * Google offers no way to create a saved list from outside — My Maps ingests
 * our KML, but that is a map layer, not the list a person can paste into a
 * message, a doc or a blog post. This is that: the same handoff the place card
 * and the share page give, in a file.
 */
export function exportListMarkdown(list: List, views: ExportPlaceView[]): string {
  const lines: string[] = [`# ${list.name}`, ""];
  for (const row of rows(views)) {
    const name = row.facts.name ?? "Unnamed place";
    const links = placeLinksFor({
      lat: row.facts.lat,
      lng: row.facts.lng,
      name,
      // The retained Google listing reopens the exact place; without one every
      // provider still gets a working coordinate/name search.
      ...(googleListingUrl(row.place) ? { externalUrl: googleListingUrl(row.place) } : {}),
      ...(row.place.currentOsmRef ? { osmRef: row.place.currentOsmRef } : {}),
    });
    const subtitle = [row.facts.category, row.facts.address].filter(Boolean).join(" · ");
    lines.push(`## ${name}`, "");
    if (subtitle) lines.push(subtitle, "");
    if (row.tags.length > 0) lines.push(`Tags: ${row.tags.join(", ")}`, "");
    // Notes are already Markdown, so they pass through verbatim.
    if (row.note) lines.push(row.note, "");
    lines.push(
      [
        `[Google Maps](${links.google})`,
        `[Apple Maps](${links.apple})`,
        ...(links.osm ? [`[OpenStreetMap](${links.osm})`] : []),
      ].join(" · "),
      "",
    );
  }
  if (hasOsmDerived(views)) lines.push("---", "", OSM_ATTRIBUTION_TEXT, "");
  return lines.join("\n");
}

export function exportListGpx(list: List, views: ExportPlaceView[]): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="Placemarks" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <metadata>`,
    `    <name>${xmlEscape(list.name)}</name>`,
  ];
  if (hasOsmDerived(views)) {
    lines.push(
      `    <copyright author="OpenStreetMap contributors">`,
      `      <license>https://opendatacommons.org/licenses/odbl/1-0/</license>`,
      `    </copyright>`,
    );
  }
  lines.push(`  </metadata>`);
  for (const row of rows(views)) {
    const desc = [row.facts.address, row.note].filter(Boolean).join("\n\n");
    lines.push(
      `  <wpt lat="${row.facts.lat}" lon="${row.facts.lng}">`,
      `    <name>${xmlEscape(row.facts.name ?? "Unnamed place")}</name>`,
      ...(desc ? [`    <desc>${xmlEscape(desc)}</desc>`] : []),
      `  </wpt>`,
    );
  }
  lines.push(`</gpx>`, ``);
  return lines.join("\n");
}
