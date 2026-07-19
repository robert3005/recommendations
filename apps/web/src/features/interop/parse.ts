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
  category?: string;
  coords?: { lat: number; lng: number };
  /** A typed OSM anchor carried by the source (our own exports) — resolved, never geocoded. */
  osmRef?: { type: "node" | "way" | "relation"; id: string };
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
  /** Marker colour carried by the source (KML styles). */
  color?: string;
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
  const category = str(props.category);
  const refMatch = str(props.osmRef)?.match(/^(node|way|relation)\/(\d+)$/);
  const osmRef = refMatch?.[1]
    ? { type: refMatch[1] as "node" | "way" | "relation", id: refMatch[2] as string }
    : undefined;
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
    ...(category ? { category } : {}),
    ...(hasCoords ? { coords: { lat, lng } } : {}),
    ...(osmRef ? { osmRef } : {}),
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

/** KML aabbggrr → #rrggbb. */
function colorFromKml(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^[0-9a-f]{2}([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return undefined;
  return `#${match[3]}${match[2]}${match[1]}`.toLowerCase();
}

/** The marker colour a KML container's placemarks reference via styleUrl. */
function containerColor(container: Element, doc: Document): string | undefined {
  const styleUrl = container.querySelector("Placemark styleUrl")?.textContent?.trim();
  if (!styleUrl?.startsWith("#")) return undefined;
  const style = doc.querySelector(`Style[id="${styleUrl.slice(1)}"] IconStyle color`);
  return colorFromKml(style?.textContent ?? undefined);
}

function kmlFragmentToList(container: Element, doc: Document, name: string): ParsedList {
  // togeojson wants a whole document: rewrap the container with the shared styles.
  const serializer = new XMLSerializer();
  const styles = [...doc.querySelectorAll("kml > Document > Style")]
    .map((el) => serializer.serializeToString(el))
    .join("");
  const wrapped = xmlDoc(
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${styles}${serializer.serializeToString(container)}</Document></kml>`,
  );
  const collection = kmlToGeoJson(wrapped) as { features?: GeoJsonFeature[] };
  const color = containerColor(container, doc);
  return { ...collectFeatures(collection.features ?? [], name), ...(color ? { color } : {}) };
}

/**
 * Folders become separate source lists, keeping their marker styles
 * (book/src/interop.md). A folderless document stays one list.
 */
export function parseKml(text: string, fallbackName: string): ParsedList[] {
  const doc = xmlDoc(text);
  const docName = doc.querySelector("Document > name")?.textContent?.trim();
  const folders = [...doc.querySelectorAll("Folder")].filter(
    (folder) => folder.querySelector("Placemark") !== null,
  );
  if (folders.length > 0) {
    return folders.map((folder, index) =>
      kmlFragmentToList(
        folder,
        doc,
        folder.querySelector(":scope > name")?.textContent?.trim() ||
          `${docName || fallbackName} ${index + 1}`,
      ),
    );
  }
  const collection = kmlToGeoJson(doc) as { features?: GeoJsonFeature[] };
  const list = collectFeatures(collection.features ?? [], docName || fallbackName);
  const rootStyle = doc.documentElement ? containerColor(doc.documentElement, doc) : undefined;
  return [{ ...list, ...(rootStyle ? { color: rootStyle } : {}) }];
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
  let savedPlaces: ParsedList | undefined;
  /** Every fid a CSV row carries — referenced geometry is not "leftover" even without coords. */
  const referencedFids = new Set<string>();

  for (const [path, fileBytes] of Object.entries(entries)) {
    if (!/saved places\.json$/i.test(path)) continue;
    savedPlaces = parseGeoJson(strFromU8(fileBytes), "Saved places", { zeroIsBug: true });
    for (const item of savedPlaces.items) {
      if (!item.coords) continue;
      const fid = googleFeatureId(item.url);
      // Joins are by Google id only — names are never identity (same-name
      // places in different cities must not collide).
      if (fid) coordsByFid.set(fid, item.coords);
    }
  }

  for (const [path, fileBytes] of Object.entries(entries)) {
    // Takeout archives contain CSVs for many products; only Saved lists count.
    if (!/(^|\/)Saved\/[^/]+\.csv$/i.test(path)) continue;
    const list = parseSavedCsv(strFromU8(fileBytes), baseName(path));
    for (const item of list.items) {
      const fid = googleFeatureId(item.url);
      if (fid) referencedFids.add(fid);
      if (item.coords || !fid) continue;
      const coords = coordsByFid.get(fid);
      if (coords) item.coords = coords;
    }
    lists.push(list);
  }

  // Geometry rows nothing referenced keep their own list (also the no-CSVs case).
  if (savedPlaces) {
    const leftover = savedPlaces.items.filter((item) => {
      const fid = googleFeatureId(item.url);
      return !(fid && referencedFids.has(fid));
    });
    // Unusable geometry rows are accounted for even when every usable row was
    // consumed by a CSV — nothing is silently dropped.
    if (leftover.length > 0 || savedPlaces.unusable.length > 0) {
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
    return { source: "kml", lists: parseKml(text(), baseName(file.name)) };
  }
  if (name.endsWith(".kmz")) {
    const entries = unzipSync(file.bytes);
    const kmlEntry = Object.entries(entries).find(([path]) => path.toLowerCase().endsWith(".kml"));
    if (!kmlEntry) throw new Error("KMZ archive contains no KML document");
    return { source: "kml", lists: parseKml(strFromU8(kmlEntry[1]), baseName(file.name)) };
  }
  if (name.endsWith(".gpx")) {
    return { source: "gpx", lists: [parseGpx(text(), baseName(file.name))] };
  }
  if (name.endsWith(".json") || name.endsWith(".geojson")) {
    return { source: "geojson", lists: [parseGeoJson(text(), baseName(file.name))] };
  }
  throw new Error(`unsupported import file: ${file.name}`);
}
