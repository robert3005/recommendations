/**
 * List export writers (book/src/interop.md §Export): KML (Google My Maps
 * ingests it), Takeout-shaped CSV (round-trips through our own importer),
 * GeoJSON, and GPX waypoints. Pure string builders — golden-snapshot tested.
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
} from "@placemarks/domain";
import Papa from "papaparse";
import { DEFAULT_PIN_COLOR } from "../../lib/markers";

export interface ExportPlaceView {
  place: Place;
  notes: Note[];
}

const OSM_ATTRIBUTION_TEXT =
  "Contains OSM-derived data © OpenStreetMap contributors, ODbL 1.0 (opendatacommons.org/licenses/odbl/1-0/)";

interface ExportRow {
  facts: DisplayFacts;
  place: Place;
  note?: string;
}

function rows(views: ExportPlaceView[]): ExportRow[] {
  const out: ExportRow[] = [];
  for (const view of views) {
    const facts = displayFacts(view.place);
    if (!facts) continue;
    const note = view.notes
      .map((n) => n.body.trim())
      .filter(Boolean)
      .join("\n\n");
    out.push({ facts, place: view.place, ...(note ? { note } : {}) });
  }
  return out;
}

const hasOsmDerived = (views: ExportPlaceView[]): boolean =>
  views.some((v) => v.place.lastVerified !== undefined);

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
  lines.push(
    `    <Style id="marker"><IconStyle><color>${kmlColor(list.color)}</color></IconStyle></Style>`,
  );
  for (const row of rows(views)) {
    const description = [row.facts.address, row.note].filter(Boolean).join("\n\n");
    lines.push(
      `    <Placemark>`,
      `      <name>${xmlEscape(row.facts.name ?? "Unnamed place")}</name>`,
      ...(description ? [`      <description>${xmlEscape(description)}</description>`] : []),
      `      <styleUrl>#marker</styleUrl>`,
      `      <Point><coordinates>${row.facts.lng},${row.facts.lat}</coordinates></Point>`,
      `    </Placemark>`,
    );
  }
  lines.push(`  </Document>`, `</kml>`, ``);
  return lines.join("\n");
}

/** The URL column mirrors import provenance: external ref, else OSM portal, else coordinates. */
function urlFor(row: ExportRow): string {
  const external = row.place.externalRefs?.[0]?.url;
  if (external) return external;
  if (row.place.currentOsmRef) return osmElementUrl(row.place.currentOsmRef);
  return `https://www.google.com/maps/search/?api=1&query=${row.facts.lat},${row.facts.lng}`;
}

export function exportListCsv(_list: List, views: ExportPlaceView[]): string {
  return `${Papa.unparse(
    {
      fields: ["Title", "Note", "URL", "Address"],
      data: rows(views).map((row) => [
        row.facts.name ?? "Unnamed place",
        row.note ?? "",
        urlFor(row),
        row.facts.address ?? "",
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
        ...(row.note ? { note: row.note } : {}),
        ...(row.place.currentOsmRef
          ? { osmRef: `${row.place.currentOsmRef.type}/${row.place.currentOsmRef.id}` }
          : {}),
        ...(row.place.externalRefs?.length
          ? { externalUrls: row.place.externalRefs.map((r) => r.url) }
          : {}),
      },
    })),
  };
  return `${JSON.stringify(collection, null, 2)}\n`;
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
