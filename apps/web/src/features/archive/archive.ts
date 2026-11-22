/**
 * Library-archive glue (spec/src/interop.md §The library archive): download
 * and upload over repo.exportLibrary/importLibrary, plus the periodic export
 * reminder (spec/src/storage.md §Eviction honesty). The archive is one JSON
 * file of the whole library, preserving all entity ids; editor tokens ride
 * along only on an explicit credentials-included export.
 */
import { MARKER_SHAPES } from "@placemarks/domain";
import type { LibraryArchive, LocalRepository } from "../../data/repo";
import { downloadText } from "../../lib/download";

export const ARCHIVE_REMINDER_DAYS = 30;
const LAST_EXPORT_KEY = "archive.lastExportedAt";

/** A credentials-included file contains secrets — its name says so. */
export function archiveFileName(now: string, includeCredentials: boolean): string {
  const day = now.slice(0, 10);
  return includeCredentials
    ? `placemarks-library-${day}-WITH-CREDENTIALS.json`
    : `placemarks-library-${day}.json`;
}

export async function exportArchive(
  repo: LocalRepository,
  opts: { includeCredentials: boolean },
  now: string,
): Promise<void> {
  const archive = await repo.exportLibrary({ includeCredentials: opts.includeCredentials });
  downloadText(
    archiveFileName(now, opts.includeCredentials),
    "application/json",
    `${JSON.stringify(archive, null, 2)}\n`,
  );
  await recordArchiveExport(repo, now);
}

export async function importArchiveFile(
  repo: LocalRepository,
  file: { text(): Promise<string> },
  now: string,
): Promise<{ mode: "fresh" | "merge" }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("not a Placemarks library archive — the file is not valid JSON");
  }
  const archive = parsed as Partial<LibraryArchive>;
  if (archive?.v !== 1 || archive.kind !== "placemarks-library") {
    throw new Error("not a Placemarks library archive");
  }
  validateArchiveRows(archive as LibraryArchive);
  return repo.importLibrary(archive as LibraryArchive, now);
}

const SHAPES = new Set<string>(MARKER_SHAPES);

function malformed(what: string): never {
  throw new Error(`not a valid Placemarks library archive — ${what}`);
}

/**
 * Row-level validation before anything is written: a hand-edited or truncated
 * archive must be refused, not inserted — a marker-less list row would crash
 * every page that draws its pin.
 */
export function validateArchiveRows(a: LibraryArchive): void {
  const sections = [a.places, a.lists, a.listEntries, a.posts, a.publications];
  if (!sections.every(Array.isArray)) malformed("a section is missing");
  for (const p of a.places) {
    if (
      typeof p.id !== "string" ||
      typeof p.name !== "string" ||
      !Number.isFinite(p.lat) ||
      !Number.isFinite(p.lng)
    ) {
      malformed("a place row is malformed");
    }
  }
  for (const l of a.lists) {
    if (
      typeof l.id !== "string" ||
      typeof l.name !== "string" ||
      !SHAPES.has(l.marker?.shape) ||
      typeof l.marker?.color !== "string"
    ) {
      malformed("a list row is malformed");
    }
  }
  for (const e of a.listEntries) {
    if (
      typeof e.id !== "string" ||
      typeof e.listId !== "string" ||
      typeof e.placeId !== "string" ||
      typeof e.rank !== "string"
    ) {
      malformed("a list entry row is malformed");
    }
  }
  for (const p of a.posts) {
    const target = p.target;
    const targetOk =
      target?.kind === "list"
        ? typeof target.listId === "string"
        : target?.kind === "place" && typeof target.placeId === "string";
    if (
      typeof p.id !== "string" ||
      typeof p.title !== "string" ||
      typeof p.body !== "string" ||
      !targetOk
    ) {
      malformed("a post row is malformed");
    }
  }
  // Saved views arrived later: an archive without the section is valid.
  if (a.views !== undefined && !Array.isArray(a.views)) malformed("the views section is malformed");
  for (const v of a.views ?? []) {
    if (
      typeof v.id !== "string" ||
      typeof v.name !== "string" ||
      !SHAPES.has(v.marker?.shape) ||
      typeof v.marker?.color !== "string" ||
      typeof v.filter !== "object" ||
      v.filter === null
    ) {
      malformed("a saved view row is malformed");
    }
  }
  for (const p of a.publications) {
    const kindOk = p.target?.kind === "list" || p.target?.kind === "post";
    if (
      typeof p.id !== "string" ||
      typeof p.slug !== "string" ||
      !kindOk ||
      typeof p.target.id !== "string"
    ) {
      malformed("a publication row is malformed");
    }
  }
}

export async function recordArchiveExport(repo: LocalRepository, now: string): Promise<void> {
  await repo.setSetting(LAST_EXPORT_KEY, now);
}

export async function lastArchiveExportAt(repo: LocalRepository): Promise<string | undefined> {
  return repo.getSetting<string>(LAST_EXPORT_KEY);
}

/**
 * Remind when the library holds anything worth losing and no archive was
 * exported within the window — a nudge, never a nag. A missing, unparseable,
 * or future timestamp is not a usable export record.
 */
export async function shouldRemindArchiveExport(
  repo: LocalRepository,
  now: string,
): Promise<boolean> {
  const [lists, posts, places] = await Promise.all([
    repo.listLists(),
    repo.allPosts(),
    repo.listPlaceViews(),
  ]);
  // A library of places on no list is as worth backing up as one with lists.
  if (lists.length === 0 && posts.length === 0 && places.length === 0) return false;
  const last = await lastArchiveExportAt(repo);
  if (!last || !Number.isFinite(Date.parse(last))) return true;
  const elapsed = Date.parse(now) - Date.parse(last);
  if (elapsed < 0) return true;
  return elapsed > ARCHIVE_REMINDER_DAYS * 24 * 60 * 60 * 1000;
}
