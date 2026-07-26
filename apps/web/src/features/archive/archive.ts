/**
 * Library-archive glue (spec/src/interop.md §The library archive): download
 * and upload over repo.exportLibrary/importLibrary, plus the periodic export
 * reminder (spec/src/storage.md §Eviction honesty). The archive is one JSON
 * file of the whole library, preserving all entity ids; editor tokens ride
 * along only on an explicit credentials-included export.
 */
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
  return repo.importLibrary(archive as LibraryArchive, now);
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
  const [lists, posts] = await Promise.all([repo.listLists(), repo.allPosts()]);
  if (lists.length === 0 && posts.length === 0) return false;
  const last = await lastArchiveExportAt(repo);
  if (!last || !Number.isFinite(Date.parse(last))) return true;
  const elapsed = Date.parse(now) - Date.parse(last);
  if (elapsed < 0) return true;
  return elapsed > ARCHIVE_REMINDER_DAYS * 24 * 60 * 60 * 1000;
}
