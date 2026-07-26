/**
 * Import parsers (spec/src/interop.md §Import): Google Takeout archives (Saved
 * CSVs + Saved Places.json), standalone pieces of one, and My Maps KML/KMZ —
 * parsed locally, never fetched. GPX and GeoJSON are export-only formats.
 * Every source row becomes a ParsedItem or an explicit `unusable` entry; rows
 * are never silently dropped.
 */
import { googleFeatureId, type ImportBatch } from "@placemarks/domain";
import { kml as kmlToGeoJson } from "@tmcw/togeojson";
import { strFromU8, unzipSync } from "fflate";
import Papa from "papaparse";

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
  /** Import binding (spec/src/interop.md §Source-list binding): the CSV or
   *  GeoJSON filename, or the KML folder id — set on the list at creation. */
  sourceKey?: string;
  items: ParsedItem[];
  /** Source rows that could not become items (no title / no point geometry) — reported, never silent. */
  unusable: UnusableRow[];
  /** Marker colour carried by the source (KML styles) — snapped to the nearest accent on assignment. */
  color?: string;
}

export interface ParsedImport {
  source: ImportBatch["source"];
  lists: ParsedList[];
}

/** "Takeout/Saved/Lisbon trip.csv" → "Lisbon trip.csv" (the sourceKey shape). */
function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function baseName(path: string): string {
  return fileName(path).replace(/\.[a-z0-9]+$/i, "");
}

const coordsValid = (lat: number, lng: number): boolean =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180;

/**
 * Literal coordinates embedded in a dropped-pin URL — the ladder's first rung
 * (spec/src/interop.md §The coordinate ladder). Deliberately narrower than the
 * domain link parser: a place URL's `@lat,lng` camera is NOT literal source
 * coordinates and must fall through to the later rungs.
 */
export function droppedPinCoords(
  url: string | undefined,
): { lat: number; lng: number } | undefined {
  if (!url) return undefined;
  const match =
    url.match(/\/maps\/search\/(-?\d{1,3}(?:\.\d+)?),\s*\+?(-?\d{1,3}(?:\.\d+)?)(?![\d.])/) ??
    url.match(/[?&](?:q|ll|query)=(-?\d{1,3}(?:\.\d+)?)(?:,|%2C)\s*(-?\d{1,3}(?:\.\d+)?)(?![\d.])/);
  if (!match?.[1] || !match[2]) return undefined;
  const lat = Number.parseFloat(match[1]);
  const lng = Number.parseFloat(match[2]);
  return coordsValid(lat, lng) ? { lat, lng } : undefined;
}

// ---------- CSV (Takeout "Saved": Title, Note, URL, Address — no coordinates) ----------

export function parseSavedCsv(text: string, listName: string, sourceKey?: string): ParsedList {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const items: ParsedItem[] = [];
  const unusable: UnusableRow[] = [];
  for (const row of parsed.data) {
    const title = row.title?.trim() || undefined;
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
    let repairedUrl = url;
    let repairedAddress = address;
    // Unquoted Google URLs carry a comma (lat,lng) that splits the columns —
    // stitch them back together instead of losing the coordinates.
    if (
      repairedUrl &&
      /\/maps\/search\/-?\d{1,3}(\.\d+)?$/.test(repairedUrl) &&
      repairedAddress &&
      /^-?\d{1,3}(\.\d+)?$/.test(repairedAddress)
    ) {
      repairedUrl = `${repairedUrl},${repairedAddress}`;
      const extra = (row as { __parsed_extra?: unknown[] }).__parsed_extra?.[0];
      repairedAddress = typeof extra === "string" && extra.trim() !== "" ? extra.trim() : undefined;
    }
    const coords = droppedPinCoords(repairedUrl);
    items.push({
      title,
      ...(note ? { note } : {}),
      ...(repairedUrl ? { url: repairedUrl } : {}),
      ...(repairedAddress ? { address: repairedAddress } : {}),
      ...(coords ? { coords } : {}),
    });
  }
  return { name: listName, ...(sourceKey ? { sourceKey } : {}), items, unusable };
}

// ---------- Saved Places.json (Google's GeoJSON shape — geometry, no list structure) ----------

interface GeoJsonFeature {
  geometry?: { type?: string; coordinates?: number[] };
  properties?: Record<string, unknown>;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

function savedPlacesFeatureToItem(feature: GeoJsonFeature): ParsedItem | undefined {
  if (feature.geometry?.type !== "Point") return undefined;
  const [lng, lat] = feature.geometry.coordinates ?? [];
  const props = feature.properties ?? {};
  const location = (props.Location ?? {}) as Record<string, unknown>;
  const title = str(props.Title) ?? str(location["Business Name"]);
  if (!title) return undefined;
  const url = str(props["Google Maps URL"]);
  const address = str(location.Address);
  // Google's known [0, 0] bug: zero-island geometry is treated as absent.
  const hasCoords =
    typeof lat === "number" &&
    typeof lng === "number" &&
    coordsValid(lat, lng) &&
    !(lat === 0 && lng === 0);
  return {
    title,
    ...(url ? { url } : {}),
    ...(address ? { address } : {}),
    ...(hasCoords ? { coords: { lat, lng } } : {}),
  };
}

/** The auto-created "Saved places" list, bound to the GeoJSON filename (spec/src/interop.md). */
export const SAVED_PLACES_LIST_NAME = "Saved places";

export function parseSavedPlacesJson(text: string, sourceKey: string): ParsedList {
  const body = JSON.parse(text) as { features?: GeoJsonFeature[] };
  const items: ParsedItem[] = [];
  const unusable: UnusableRow[] = [];
  for (const feature of body.features ?? []) {
    const item = savedPlacesFeatureToItem(feature);
    if (item) items.push(item);
    else unusable.push({ title: str(feature.properties?.Title) ?? "" });
  }
  return { name: SAVED_PLACES_LIST_NAME, sourceKey, items, unusable };
}

// ---------- KML / KMZ (My Maps custom maps; coordinates included) ----------

function xmlDoc(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("malformed XML — the file could not be parsed");
  }
  return doc;
}

/** KML aabbggrr → #rrggbb. */
function colorFromKml(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^[0-9a-f]{2}([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return undefined;
  return `#${match[3]}${match[2]}${match[1]}`.toLowerCase();
}

/** Resolve a styleUrl to an IconStyle colour, following one StyleMap hop. */
function styleColor(id: string, doc: Document): string | undefined {
  const direct = doc.querySelector(`Style[id="${id}"] IconStyle color`);
  if (direct) return colorFromKml(direct.textContent ?? undefined);
  // A StyleMap's NORMAL pair is the resting marker — never the highlight,
  // whatever order the pairs are declared in.
  const pairs = [...doc.querySelectorAll(`StyleMap[id="${id}"] Pair`)];
  const normal =
    pairs.find((pair) => pair.querySelector("key")?.textContent?.trim() === "normal") ?? pairs[0];
  const mapped = normal?.querySelector("styleUrl")?.textContent?.trim();
  if (mapped?.startsWith("#")) {
    const target = doc.querySelector(`Style[id="${mapped.slice(1)}"] IconStyle color`);
    return colorFromKml(target?.textContent ?? undefined);
  }
  return undefined;
}

/**
 * The marker colour a KML container's DIRECT placemarks reference via
 * styleUrl — a nested folder's style belongs to that folder's own list.
 */
function containerColor(container: Element, doc: Document): string | undefined {
  const styleUrl = container.querySelector(":scope > Placemark > styleUrl")?.textContent?.trim();
  if (!styleUrl?.startsWith("#")) return undefined;
  return styleColor(styleUrl.slice(1), doc);
}

function kmlFeaturesToList(features: GeoJsonFeature[], name: string): ParsedList {
  const items: ParsedItem[] = [];
  const unusable: UnusableRow[] = [];
  for (const feature of features) {
    if (feature.geometry?.type !== "Point") {
      unusable.push({ title: str(feature.properties?.name) ?? "" });
      continue;
    }
    const [lng, lat] = feature.geometry.coordinates ?? [];
    const title = str(feature.properties?.name);
    if (!title || typeof lat !== "number" || typeof lng !== "number" || !coordsValid(lat, lng)) {
      unusable.push({ title: title ?? "" });
      continue;
    }
    const note = str(feature.properties?.description);
    items.push({ title, ...(note ? { note } : {}), coords: { lat, lng } });
  }
  return { name, items, unusable };
}

function kmlFragmentToList(
  container: Element,
  doc: Document,
  name: string,
  sourceKey: string,
): ParsedList {
  // togeojson wants a whole document: rewrap the container's DIRECT placemarks
  // with the shared styles (nested folders become their own lists).
  const serializer = new XMLSerializer();
  const styles = [...doc.querySelectorAll("kml > Document > Style, kml > Document > StyleMap")]
    .map((el) => serializer.serializeToString(el))
    .join("");
  const own = [...container.querySelectorAll(":scope > Placemark")]
    .map((el) => serializer.serializeToString(el))
    .join("");
  const wrapped = xmlDoc(
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${styles}${own}</Document></kml>`,
  );
  const collection = kmlToGeoJson(wrapped) as { features?: GeoJsonFeature[] };
  const color = containerColor(container, doc);
  return {
    ...kmlFeaturesToList(collection.features ?? [], name),
    sourceKey,
    ...(color ? { color } : {}),
  };
}

/**
 * Folders become separate source lists, keeping their marker styles
 * (spec/src/interop.md §Google My Maps via KML/KMZ). A folderless document
 * stays one list.
 */
export function parseKml(text: string, fallbackName: string): ParsedList[] {
  const doc = xmlDoc(text);
  const docName = doc.querySelector("Document > name")?.textContent?.trim();
  // Every folder with DIRECT placemarks becomes a list of exactly those —
  // nested folders are their own lists, and nothing is duplicated.
  const folders = [...doc.querySelectorAll("Folder")].filter(
    (folder) => folder.querySelector(":scope > Placemark") !== null,
  );
  if (folders.length === 0) {
    const collection = kmlToGeoJson(doc) as { features?: GeoJsonFeature[] };
    const name = docName || fallbackName;
    const list = kmlFeaturesToList(collection.features ?? [], name);
    const rootContainer = doc.querySelector("kml > Document") ?? doc.documentElement;
    const rootColor = rootContainer ? containerColor(rootContainer, doc) : undefined;
    return [{ ...list, sourceKey: name, ...(rootColor ? { color: rootColor } : {}) }];
  }
  const lists: ParsedList[] = [];
  const usedNames = new Map<string, number>();
  const uniqueName = (raw: string): string => {
    const seen = usedNames.get(raw) ?? 0;
    usedNames.set(raw, seen + 1);
    return seen === 0 ? raw : `${raw} (${(seen + 1).toString()})`;
  };
  // Loose document-level placemarks are their own list — never silently lost.
  const loose = [...doc.querySelectorAll("kml > Document > Placemark")];
  if (loose.length > 0) {
    const serializer = new XMLSerializer();
    const styles = [...doc.querySelectorAll("kml > Document > Style, kml > Document > StyleMap")]
      .map((el) => serializer.serializeToString(el))
      .join("");
    const wrapped = xmlDoc(
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${styles}${loose
        .map((el) => serializer.serializeToString(el))
        .join("")}</Document></kml>`,
    );
    const collection = kmlToGeoJson(wrapped) as { features?: GeoJsonFeature[] };
    // Loose placemarks keep their own marker style beside styled folders.
    const looseStyleUrl = loose[0]?.querySelector(":scope > styleUrl")?.textContent?.trim();
    const looseColor = looseStyleUrl?.startsWith("#")
      ? styleColor(looseStyleUrl.slice(1), doc)
      : undefined;
    const name = uniqueName(docName || fallbackName);
    lists.push({
      ...kmlFeaturesToList(collection.features ?? [], name),
      sourceKey: name,
      ...(looseColor ? { color: looseColor } : {}),
    });
  }
  for (const [index, folder] of folders.entries()) {
    const name = uniqueName(
      folder.querySelector(":scope > name")?.textContent?.trim() ||
        `${docName || fallbackName} ${(index + 1).toString()}`,
    );
    // The folder id is the durable binding when the source carries one.
    const sourceKey = folder.getAttribute("id") ?? name;
    lists.push(kmlFragmentToList(folder, doc, name, sourceKey));
  }
  return lists;
}

// ---------- Takeout archive: CSV lists cross-referenced with Saved Places.json ----------

/**
 * The CSVs have list structure but no geometry; `Saved Places.json` has
 * geometry but no list structure. Rows are joined **by Google feature id** —
 * by id only, never by name. Geometry rows no CSV references become the
 * auto-created "Saved places" list — membership is existence, so a place with
 * geometry but no list still needs a list to live in (spec/src/interop.md).
 */
export function parseTakeoutZip(bytes: Uint8Array): ParsedImport {
  const entries = unzipSync(bytes);
  const recognized = Object.keys(entries).some(
    (path) => /(^|\/)Saved\/[^/]+\.csv$/i.test(path) || /saved places\.json$/i.test(path),
  );
  if (!recognized) {
    throw new Error(
      "no recognized Takeout entries — expected Saved lists (CSV) or Saved Places.json",
    );
  }
  const lists: ParsedList[] = [];
  const coordsByFid = new Map<string, { lat: number; lng: number }>();
  let savedPlaces: ParsedList | undefined;
  /** Every fid a CSV row carries — referenced geometry is not "leftover" even without coords. */
  const referencedFids = new Set<string>();

  for (const [path, fileBytes] of Object.entries(entries)) {
    if (!/saved places\.json$/i.test(path)) continue;
    savedPlaces = parseSavedPlacesJson(strFromU8(fileBytes), fileName(path));
    for (const item of savedPlaces.items) {
      if (!item.coords || !item.url) continue;
      const fid = googleFeatureId(item.url);
      // Joins are by Google id only — names are never identity (same-name
      // places in different cities must not collide).
      if (fid) coordsByFid.set(fid, item.coords);
    }
  }

  for (const [path, fileBytes] of Object.entries(entries)) {
    // Takeout archives contain CSVs for many products; only Saved lists count.
    if (!/(^|\/)Saved\/[^/]+\.csv$/i.test(path)) continue;
    const list = parseSavedCsv(strFromU8(fileBytes), baseName(path), fileName(path));
    for (const item of list.items) {
      const fid = item.url ? googleFeatureId(item.url) : undefined;
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
      const fid = item.url ? googleFeatureId(item.url) : undefined;
      return !(fid && referencedFids.has(fid));
    });
    // Unusable geometry rows are accounted for even when every usable row was
    // consumed by a CSV — nothing is silently dropped.
    if (leftover.length > 0 || savedPlaces.unusable.length > 0) {
      lists.push({ ...savedPlaces, items: leftover });
    }
  }

  return { source: "takeout", lists };
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
    return {
      source: "takeout",
      lists: [parseSavedCsv(text(), baseName(file.name), fileName(file.name))],
    };
  }
  if (name.endsWith(".kml")) {
    return { source: "mymaps-kml", lists: parseKml(text(), baseName(file.name)) };
  }
  if (name.endsWith(".kmz")) {
    const entries = unzipSync(file.bytes);
    const kmlEntry = Object.entries(entries).find(([path]) => path.toLowerCase().endsWith(".kml"));
    if (!kmlEntry) throw new Error("KMZ archive contains no KML document");
    return { source: "mymaps-kml", lists: parseKml(strFromU8(kmlEntry[1]), baseName(file.name)) };
  }
  if (name.endsWith(".json")) {
    return { source: "takeout", lists: [parseSavedPlacesJson(text(), fileName(file.name))] };
  }
  // GPX and GeoJSON are export formats only (spec/src/interop.md §Export).
  throw new Error(`unsupported import file: ${file.name}`);
}
