/**
 * Loads the classify command's output into the insights store. The user
 * picks the data folder (`~/placemarks-data`); for every place folder we read
 * place.json, photos.jsonl (plus any local photo files it names) and
 * profile.json. reviews.jsonl and analyses.*.jsonl are never read: the app
 * shows classification results, not reviews.
 */
import type { PlaceProfile } from "@placemarks/domain";
import { type InsightsDb, insightsDb, type PhotoRow, type PlaceSourceRow } from "./db";

export interface LoadSummary {
  places: number;
  profiles: number;
  photos: number;
  skipped: string[];
}

/** A file plus its path relative to the picked folder, e.g. "places/0x1_0x2/place.json". */
export interface PickedFile {
  path: string;
  file: Blob & { text(): Promise<string> };
}

/** From an <input webkitdirectory> FileList: strip the picked folder's own name. */
export function pickedFromFileList(files: FileList | File[]): PickedFile[] {
  return [...files].map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return { path: rel.split("/").slice(1).join("/") || rel, file };
  });
}

function parseJsonl(raw: string): unknown[] {
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as unknown];
      } catch {
        return [];
      }
    });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function isProfile(v: unknown): v is PlaceProfile {
  return (
    isObj(v) &&
    typeof v.sourcePlaceKey === "string" &&
    Array.isArray(v.aspects) &&
    Array.isArray(v.dishes) &&
    Array.isArray(v.tags) &&
    Array.isArray(v.warnings)
  );
}

/** Only https URLs render as photos; anything else must come as a local file. */
function safeUrl(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  try {
    return new URL(s).protocol === "https:" ? s : undefined;
  } catch {
    return undefined;
  }
}

export async function loadInsightsFolder(
  files: PickedFile[],
  now: string,
  db: InsightsDb = insightsDb(),
): Promise<LoadSummary> {
  const byDir = new Map<string, Map<string, PickedFile>>();
  for (const f of files) {
    const m = f.path.match(/^(?:.*\/)?places\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, dir, rest] = m as unknown as [string, string, string];
    const entries = byDir.get(dir) ?? new Map<string, PickedFile>();
    entries.set(rest, f);
    byDir.set(dir, entries);
  }

  const summary: LoadSummary = { places: 0, profiles: 0, photos: 0, skipped: [] };
  for (const [dir, entries] of byDir) {
    const placeFile = entries.get("place.json");
    const profileFile = entries.get("profile.json");
    if (!placeFile && !profileFile) continue;
    let place: Record<string, unknown> = {};
    let profile: PlaceProfile | undefined;
    try {
      if (placeFile) {
        const parsed: unknown = JSON.parse(await placeFile.file.text());
        if (isObj(parsed)) place = parsed;
      }
      if (profileFile) {
        const parsed: unknown = JSON.parse(await profileFile.file.text());
        if (isProfile(parsed)) profile = parsed;
      }
    } catch {
      summary.skipped.push(dir);
      continue;
    }
    // The key comes from the files, never from the folder name.
    const key = str(place.sourcePlaceKey) ?? profile?.sourcePlaceKey;
    if (!key || (profile && profile.sourcePlaceKey !== key)) {
      summary.skipped.push(dir);
      continue;
    }

    const source: PlaceSourceRow = {
      sourcePlaceKey: key,
      name: str(place.name) ?? str(place.title),
      rating: num(place.rating),
      ratingCount: num(place.ratingCount),
      priceLevel: num(place.priceLevel),
      loadedAt: now,
    };

    const photos: PhotoRow[] = [];
    const photosFile = entries.get("photos.jsonl");
    if (photosFile) {
      for (const row of parseJsonl(await photosFile.file.text())) {
        if (!isObj(row) || (str(row.sourcePlaceKey) ?? key) !== key) continue;
        const id = str(row.id);
        const attribution = isObj(row.attribution) ? row.attribution : {};
        const author = str(attribution.name);
        if (!id || !author) continue; // a photo without credit never displays
        const localPath = str(row.localPath) ?? str(row.path) ?? str(row.file);
        const local = localPath ? entries.get(localPath.replace(/^\.\//, "")) : undefined;
        const url = safeUrl(row.url);
        if (!local && !url) continue;
        photos.push({
          id,
          sourcePlaceKey: key,
          url: local ? "" : (url ?? ""),
          blob: local?.file,
          width: num(row.width),
          height: num(row.height),
          attribution: { name: author, url: safeUrl(attribution.url) },
          source: str(row.source) ?? "google",
        });
      }
    }

    await db.transaction("rw", db.placeSources, db.photos, db.placeProfiles, async () => {
      await db.placeSources.put(source);
      await db.photos.where("sourcePlaceKey").equals(key).delete();
      if (photos.length) await db.photos.bulkPut(photos);
      if (profile) await db.placeProfiles.put(profile);
    });
    summary.places++;
    summary.photos += photos.length;
    if (profile) summary.profiles++;
  }
  return summary;
}

export async function clearInsights(db: InsightsDb = insightsDb()): Promise<void> {
  await db.transaction("rw", db.placeSources, db.photos, db.placeProfiles, async () => {
    await Promise.all([db.placeSources.clear(), db.photos.clear(), db.placeProfiles.clear()]);
  });
}
