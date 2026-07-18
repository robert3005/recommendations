/**
 * Import parsers (book/src/interop.md §Import pipeline): Takeout archives,
 * standalone CSV, KML/KMZ, GPX, and GeoJSON — parsed locally, never fetched.
 * Every source row becomes a ParsedItem or an explicit `unusable` entry; rows
 * are never silently dropped.
 */
import { gpx as gpxToGeoJson, kml as kmlToGeoJson } from "@tmcw/togeojson";
import { strFromU8, unzipSync } from "fflate";
import Papa from "papaparse";
import type { ImportBatchRow } from "../../data/db";
import { googleFeatureId, googleUrlCoords } from "./googleUrl";

export interface ParsedItem {
  title: string;
  note?: string;
  url?: string;
  address?: string;
  coords?: { lat: number; lng: number };
}

export interface UnusableRow {
  title: string;
  note?: string;
  url?: string;
  address?: string;
}

export interface ParsedList {
  name: string;
  items: ParsedItem[];
  /** Source rows that could not become items (no title / no point geometry) — reported, never silent. */
  unusable: UnusableRow[];
}

export interface ParsedImport {
  source: ImportBatchRow["source"];
  lists: ParsedList[];
}

function baseName(path: string): string {
  const last = path.split("/").at(-1) ?? path;
  return last.replace(/\.[a-z0-9]+$/i, "");
}

const coordsValid = (lat: number, lng: number): boolean =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180;

// ---------- CSV (Takeout "Saved": Title, Note, URL, Address — no coordinates) ----------

export function parseSavedCsv(text: string, listName: string): ParsedList {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const items: ParsedItem[] = [];
  const unusable: UnusableRow[] = [];
  for (const row of parsed.data) {
    const title = row.title?.trim();
    const url = row.url?.trim() || undefined;
    // The note is the user's own writing — preserved exactly, never trimmed.
    const note = row.note ? row.note : undefined;
    const address = row.address?.trim() || undefined;
    if (!title) {
      unusable.push({
        title: row.title ?? "",
        ...(note ? { note } : {}),
        ...(url ? { url } : {}),
        ...(address ? { address } : {}),
      });
      continue;
    }
    const coords = googleUrlCoords(url);
    items.push({
      title,
      ...(note ? { note } : {}),
      ...(url ? { url } : {}),
      ...(address ? { address } : {}),
      ...(coords ? { coords } : {}),
    });
  }
  return { name: listName, items, unusable };
}

// ---------- GeoJSON (generic, Google's Saved Places.json shape, and our own export) ----------

interface GeoJsonFeature {
  geometry?: { type?: string; coordinates?: number[] };
  properties?: Record<string, unknown>;
}

interface FeatureOptions {
  /** Google's Saved Places.json has a known [0, 0] bug; generic GeoJSON does not. */
  zeroIsBug?: boolean;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

function featureToItem(
  feature: GeoJsonFeature,
  options: FeatureOptions = {},
): ParsedItem | undefined {
  if (feature.geometry?.type !== "Point") return undefined;
  const [lng, lat] = feature.geometry.coordinates ?? [];
  const props = feature.properties ?? {};
  const location = (props.Location ?? {}) as Record<string, unknown>;
  const title = str(props.Title) ?? str(props.name) ?? str(location["Business Name"]);
  if (!title) return undefined;
  const externalUrls = Array.isArray(props.externalUrls) ? props.externalUrls : [];
  const url = str(props["Google Maps URL"]) ?? str(props.url) ?? str(externalUrls[0]);
  const address = str(props.address) ?? str(location.Address);
  const note = str(props.description) ?? str(props.note) ?? str(props.desc);
  const hasCoords =
    typeof lat === "number" &&
    typeof lng === "number" &&
    coordsValid(lat, lng) &&
    !(options.zeroIsBug === true && lat === 0 && lng === 0);
  return {
    title,
    ...(note ? { note } : {}),
    ...(url ? { url } : {}),
    ...(address ? { address } : {}),
    ...(hasCoords ? { coords: { lat, lng } } : {}),
  };
}

function collectFeatures(
  features: GeoJsonFeature[],
  listName: string,
  options: FeatureOptions = {},
): ParsedList {
  const items: ParsedItem[] = [];
  const unusable: UnusableRow[] = [];
  for (const feature of features) {
    const item = featureToItem(feature, options);
    if (item) items.push(item);
    else unusable.push({ title: str(feature.properties?.name) ?? "" });
  }
  return { name: listName, items, unusable };
}

export function parseGeoJson(
  text: string,
  listName: string,
  options: FeatureOptions = {},
): ParsedList {
  const body = JSON.parse(text) as { features?: GeoJsonFeature[] };
  return collectFeatures(body.features ?? [], listName, options);
}

// ---------- KML / KMZ / GPX (coordinates included) ----------

function xmlDoc(text: string): Document {
  return new DOMParser().parseFromString(text, "text/xml");
}

export function parseKml(text: string, fallbackName: string): ParsedList {
  const doc = xmlDoc(text);
  const docName = doc.querySelector("Document > name")?.textContent?.trim();
  const collection = kmlToGeoJson(doc) as { features?: GeoJsonFeature[] };
  return collectFeatures(collection.features ?? [], docName || fallbackName);
}

export function parseGpx(text: string, fallbackName: string): ParsedList {
  const collection = gpxToGeoJson(xmlDoc(text)) as { features?: GeoJsonFeature[] };
  return collectFeatures(collection.features ?? [], fallbackName);
}

// ---------- Takeout archive: CSV lists cross-referenced with Saved Places.json ----------

/**
 * The CSVs have list structure but no geometry; `Saved Places.json` has
 * geometry but no list structure. Rows are joined **by Google feature id**; a
 * title join is only trusted when the row carries no id at all and the title
 * is unique in the geometry file. Geometry rows no CSV references remain their
 * own "Saved places" list — never silently lost (book/src/interop.md).
 */
export function parseTakeoutZip(bytes: Uint8Array): ParsedImport {
  const entries = unzipSync(bytes);
  const lists: ParsedList[] = [];
  const coordsByFid = new Map<string, { lat: number; lng: number }>();
  const titleCounts = new Map<string, number>();
  const coordsByUniqueTitle = new Map<string, { lat: number; lng: number }>();
  let savedPlaces: ParsedList | undefined;
  /** Every fid a CSV row carries — referenced geometry is not "leftover" even without coords. */
  const referencedFids = new Set<string>();
  const consumedTitles = new Set<string>();

  for (const [path, fileBytes] of Object.entries(entries)) {
    if (!/saved places\.json$/i.test(path)) continue;
    savedPlaces = parseGeoJson(strFromU8(fileBytes), "Saved places", { zeroIsBug: true });
    for (const item of savedPlaces.items) {
      const key = item.title.toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    for (const item of savedPlaces.items) {
      if (!item.coords) continue;
      const fid = googleFeatureId(item.url);
      if (fid) coordsByFid.set(fid, item.coords);
      const key = item.title.toLowerCase();
      if (titleCounts.get(key) === 1) coordsByUniqueTitle.set(key, item.coords);
    }
  }

  for (const [path, fileBytes] of Object.entries(entries)) {
    // Takeout archives contain CSVs for many products; only Saved lists count.
    if (!/(^|\/)Saved\/[^/]+\.csv$/i.test(path)) continue;
    const list = parseSavedCsv(strFromU8(fileBytes), baseName(path));
    for (const item of list.items) {
      const fid = googleFeatureId(item.url);
      if (fid) referencedFids.add(fid);
      if (item.coords) continue;
      if (fid) {
        // A row with an id joins by id only — same names are not the same place.
        const coords = coordsByFid.get(fid);
        if (coords) item.coords = coords;
        continue;
      }
      const key = item.title.toLowerCase();
      const coords = coordsByUniqueTitle.get(key);
      if (coords) {
        item.coords = coords;
        consumedTitles.add(key);
      }
    }
    lists.push(list);
  }

  // Geometry rows nothing referenced keep their own list (also the no-CSVs case).
  if (savedPlaces) {
    const leftover = savedPlaces.items.filter((item) => {
      const fid = googleFeatureId(item.url);
      if (fid && referencedFids.has(fid)) return false;
      return !consumedTitles.has(item.title.toLowerCase());
    });
    if (leftover.length > 0 || (lists.length === 0 && savedPlaces.unusable.length > 0)) {
      lists.push({ name: savedPlaces.name, items: leftover, unusable: savedPlaces.unusable });
    }
  }

  return { source: "google-takeout", lists };
}

// ---------- Entry point ----------

export async function parseImportFile(file: {
  name: string;
  bytes: Uint8Array;
}): Promise<ParsedImport> {
  const name = file.name.toLowerCase();
  const text = () => strFromU8(file.bytes);
  if (name.endsWith(".zip")) return parseTakeoutZip(file.bytes);
  if (name.endsWith(".csv")) {
    return { source: "csv", lists: [parseSavedCsv(text(), baseName(file.name))] };
  }
  if (name.endsWith(".kml")) {
    return { source: "kml", lists: [parseKml(text(), baseName(file.name))] };
  }
  if (name.endsWith(".kmz")) {
    const entries = unzipSync(file.bytes);
    const kmlEntry = Object.entries(entries).find(([path]) => path.toLowerCase().endsWith(".kml"));
    if (!kmlEntry) throw new Error("KMZ archive contains no KML document");
    return { source: "kml", lists: [parseKml(strFromU8(kmlEntry[1]), baseName(file.name))] };
  }
  if (name.endsWith(".gpx")) {
    return { source: "gpx", lists: [parseGpx(text(), baseName(file.name))] };
  }
  if (name.endsWith(".json") || name.endsWith(".geojson")) {
    return { source: "geojson", lists: [parseGeoJson(text(), baseName(file.name))] };
  }
  throw new Error(`unsupported import file: ${file.name}`);
}
