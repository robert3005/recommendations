/**
 * Harvest inputs from a Google Takeout archive: the Saved-list CSVs (Title,
 * Note, URL, Address) plus `Saved Places.json`. Only rows with a Google place
 * URL become inputs — dropped-pin search URLs name no listing, so there are no
 * reviews to fetch for them. The web importer (apps/web/src/features/interop)
 * stays the way places enter the library; this only decides what to harvest.
 */
import { googleFeatureId } from "@placemarks/domain";
import { strFromU8, unzipSync } from "fflate";
import Papa from "papaparse";
import type { HarvestInput } from "./providers/types";

export interface TakeoutInputs {
  inputs: HarvestInput[];
  /** Rows that name no Google listing (dropped pins, blank URLs). */
  skipped: { list: string; title: string; reason: string }[];
}

const fileName = (p: string) => p.split("/").pop() ?? p;

function isPlaceUrl(url: string): boolean {
  return /google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(url);
}

function addRow(
  out: TakeoutInputs,
  seen: Set<string>,
  list: string,
  title: string,
  url: string | undefined,
): void {
  const trimmed = url?.trim();
  if (!trimmed || !isPlaceUrl(trimmed)) {
    out.skipped.push({ list, title, reason: "no Google Maps URL" });
    return;
  }
  const key = googleFeatureId(trimmed);
  if (!key) {
    out.skipped.push({ list, title, reason: "dropped pin — no Google listing to fetch" });
    return;
  }
  if (seen.has(key)) return; // the same place in several lists is fetched once
  seen.add(key);
  out.inputs.push({ query: trimmed, kind: "url", list, ...(title ? { title } : {}) });
}

export function inputsFromSavedCsv(
  text: string,
  list: string,
  out: TakeoutInputs,
  seen: Set<string>,
) {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: true,
  });
  for (const row of parsed.data) {
    addRow(out, seen, list, row.Title?.trim() ?? "", row.URL);
  }
}

interface SavedPlacesFeature {
  properties?: {
    google_maps_url?: string;
    Title?: string;
    location?: { name?: string; Title?: string };
  };
}

export function inputsFromSavedPlacesJson(
  text: string,
  list: string,
  out: TakeoutInputs,
  seen: Set<string>,
) {
  const json = JSON.parse(text) as { features?: SavedPlacesFeature[] };
  for (const feature of json.features ?? []) {
    const props = feature.properties ?? {};
    const title = props.location?.name ?? props.Title ?? props.location?.Title ?? "";
    addRow(out, seen, list, title, props.google_maps_url);
  }
}

/** A Takeout .zip, a single Saved-list .csv, or a `Saved Places.json`. */
export function inputsFromTakeoutFile(name: string, bytes: Uint8Array): TakeoutInputs {
  const out: TakeoutInputs = { inputs: [], skipped: [] };
  const seen = new Set<string>();
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) {
    inputsFromSavedCsv(strFromU8(bytes), fileName(name), out, seen);
  } else if (lower.endsWith(".json")) {
    inputsFromSavedPlacesJson(strFromU8(bytes), fileName(name), out, seen);
  } else if (lower.endsWith(".zip")) {
    const entries = unzipSync(bytes);
    // CSVs first, so a place keeps the list name rather than "Saved Places.json".
    for (const [entryPath, data] of Object.entries(entries)) {
      if (/(^|\/)Saved\/[^/]+\.csv$/i.test(entryPath)) {
        inputsFromSavedCsv(strFromU8(data), fileName(entryPath), out, seen);
      }
    }
    for (const [entryPath, data] of Object.entries(entries)) {
      if (/saved places\.json$/i.test(entryPath)) {
        inputsFromSavedPlacesJson(strFromU8(data), fileName(entryPath), out, seen);
      }
    }
  } else {
    throw new Error(`${name}: expected a Takeout .zip, a Saved-list .csv or Saved Places.json`);
  }
  return out;
}
