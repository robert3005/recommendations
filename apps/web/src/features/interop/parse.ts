/**
 * Import parsers (book/src/interop.md §Import pipeline): Takeout archives,
 * standalone CSV, KML/KMZ, GPX, and GeoJSON — parsed locally, never fetched.
 * Every source row becomes a ParsedItem; each source list (CSV file, KML
 * document) proposes a list. Rows are never silently dropped: a row that can't
 * be placed still reaches the review queue downstream.
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

export interface ParsedList {
  name: string;
  items: ParsedItem[];
  /** Source rows that could not become items (no title / no point geometry) — reported, never silent. */
  dropped: number;
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
  lng <= 180 &&
  // Google's Saved Places.json has a known [0, 0] bug (book/src/interop.md).
  !(lat === 0 && lng === 0);

// ---------- CSV (Takeout "Saved": Title, Note, URL, Address — no coordinates) ----------

export function parseSavedCsv(text: string, listName: string): ParsedList {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const items: ParsedItem[] = [];
  let dropped = 0;
  for (const row of parsed.data) {
    const title = row.title?.trim();
    if (!title) {
      dropped += 1;
      continue;
    }
    const url = row.url?.trim() || undefined;
    const coords = googleUrlCoords(url);
    items.push({
      title,
      ...(row.note?.trim() ? { note: row.note.trim() } : {}),
      ...(url ? { url } : {}),
      ...(row.address?.trim() ? { address: row.address.trim() } : {}),
      ...(coords ? { coords } : {}),
    });
  }
  return { name: listName, items, dropped };
}

// ---------- GeoJSON (generic, and Google's Saved Places.json shape) ----------

interface GeoJsonFeature {
  geometry?: { type?: string; coordinates?: number[] };
  properties?: Record<string, unknown>;
}

function featureToItem(feature: GeoJsonFeature): ParsedItem | undefined {
  if (feature.geometry?.type !== "Point") return undefined;
  const [lng, lat] = feature.geometry.coordinates ?? [];
  const props = feature.properties ?? {};
  const location = (props.Location ?? {}) as Record<string, unknown>;
  const title =
    (typeof props.Title === "string" && props.Title) ||
    (typeof props.name === "string" && props.name) ||
    (typeof location["Business Name"] === "string" && (location["Business Name"] as string)) ||
    undefined;
  if (!title) return undefined;
  const url =
    (typeof props["Google Maps URL"] === "string" && (props["Google Maps URL"] as string)) ||
    undefined;
  const address =
    (typeof props.address === "string" && props.address) ||
    (typeof location.Address === "string" && (location.Address as string)) ||
    undefined;
  const note = typeof props.description === "string" ? props.description : undefined;
  const hasCoords = typeof lat === "number" && typeof lng === "number" && coordsValid(lat, lng);
  return {
    title,
    ...(note ? { note } : {}),
    ...(url ? { url } : {}),
    ...(address ? { address } : {}),
    ...(hasCoords ? { coords: { lat, lng } } : {}),
  };
}

function collectFeatures(features: GeoJsonFeature[], listName: string): ParsedList {
  const items: ParsedItem[] = [];
  let dropped = 0;
  for (const feature of features) {
    const item = featureToItem(feature);
    if (item) items.push(item);
    else dropped += 1;
  }
  return { name: listName, items, dropped };
}

export function parseGeoJson(text: string, listName: string): ParsedList {
  const body = JSON.parse(text) as { features?: GeoJsonFeature[] };
  return collectFeatures(body.features ?? [], listName);
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
 * geometry but no list structure. Joined by Google feature id (then title),
 * each source compensates for the other (book/src/interop.md).
 */
export function parseTakeoutZip(bytes: Uint8Array): ParsedImport {
  const entries = unzipSync(bytes);
  const lists: ParsedList[] = [];
  const coordsByFid = new Map<string, { lat: number; lng: number }>();
  const coordsByTitle = new Map<string, { lat: number; lng: number }>();
  let savedPlaces: ParsedList | undefined;

  for (const [path, fileBytes] of Object.entries(entries)) {
    if (!/saved places\.json$/i.test(path)) continue;
    savedPlaces = parseGeoJson(strFromU8(fileBytes), "Saved places");
    for (const item of savedPlaces.items) {
      if (!item.coords) continue;
      const fid = googleFeatureId(item.url);
      if (fid) coordsByFid.set(fid, item.coords);
      coordsByTitle.set(item.title.toLowerCase(), item.coords);
    }
  }

  for (const [path, fileBytes] of Object.entries(entries)) {
    if (!/\.csv$/i.test(path)) continue;
    const list = parseSavedCsv(strFromU8(fileBytes), baseName(path));
    for (const item of list.items) {
      if (item.coords) continue;
      const fid = googleFeatureId(item.url);
      const coords =
        (fid ? coordsByFid.get(fid) : undefined) ?? coordsByTitle.get(item.title.toLowerCase());
      if (coords) item.coords = coords;
    }
    lists.push(list);
  }

  // Without CSVs, the starred GeoJSON is the only structure — import it as a list.
  if (lists.length === 0 && savedPlaces && savedPlaces.items.length > 0) lists.push(savedPlaces);

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
