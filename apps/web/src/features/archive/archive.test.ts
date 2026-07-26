/**
 * Library-archive glue (spec/src/interop.md §The library archive,
 * spec/src/storage.md §Eviction honesty): file naming that names its secrets,
 * shape validation before restore, and the periodic export reminder rules.
 */
import { describe, expect, it } from "vitest";
import type { LibraryArchive, LocalRepository } from "../../data/repo";
import {
  archiveFileName,
  importArchiveFile,
  recordArchiveExport,
  shouldRemindArchiveExport,
} from "./archive";

const NOW = "2026-07-26T12:00:00.000Z";

/** The slice of the repository the reminder and restore glue touch. */
function repoStub(opts: { lists?: number; posts?: number } = {}) {
  const settings = new Map<string, unknown>();
  const imported: LibraryArchive[] = [];
  const stub = {
    listLists: () =>
      Promise.resolve(
        Array.from({ length: opts.lists ?? 0 }, (_, i) => ({ id: `l${i.toString()}` })),
      ),
    allPosts: () =>
      Promise.resolve(
        Array.from({ length: opts.posts ?? 0 }, (_, i) => ({ id: `p${i.toString()}` })),
      ),
    getSetting: (key: string) => Promise.resolve(settings.get(key)),
    setSetting: (key: string, value: unknown) => {
      settings.set(key, value);
      return Promise.resolve();
    },
    importLibrary: (a: LibraryArchive) => {
      imported.push(a);
      return Promise.resolve({ mode: "fresh" as const });
    },
  };
  return { repo: stub as unknown as LocalRepository, imported };
}

const fileOf = (content: string) => ({ text: () => Promise.resolve(content) });

describe("archiveFileName", () => {
  it("names a credentials-included file as containing secrets", () => {
    expect(archiveFileName(NOW, false)).toBe("placemarks-library-2026-07-26.json");
    expect(archiveFileName(NOW, true)).toBe("placemarks-library-2026-07-26-WITH-CREDENTIALS.json");
  });
});

describe("importArchiveFile", () => {
  it("refuses non-JSON and foreign shapes before touching the repository", async () => {
    const { repo, imported } = repoStub();
    await expect(importArchiveFile(repo, fileOf("not json"), NOW)).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(
      importArchiveFile(repo, fileOf(`{"v":2,"kind":"placemarks-library"}`), NOW),
    ).rejects.toThrow(/not a Placemarks library archive/);
    await expect(
      importArchiveFile(repo, fileOf(`{"v":1,"kind":"something-else"}`), NOW),
    ).rejects.toThrow(/not a Placemarks library archive/);
    expect(imported).toHaveLength(0);
  });

  it("hands a valid archive to repo.importLibrary", async () => {
    const { repo, imported } = repoStub();
    const archive: LibraryArchive = {
      v: 1,
      kind: "placemarks-library",
      exportedAt: NOW,
      places: [],
      lists: [],
      listEntries: [],
      posts: [],
      publications: [],
    };
    const result = await importArchiveFile(repo, fileOf(JSON.stringify(archive)), NOW);
    expect(result.mode).toBe("fresh");
    expect(imported).toHaveLength(1);
  });
});

describe("shouldRemindArchiveExport", () => {
  it("stays quiet for an empty library", async () => {
    const { repo } = repoStub();
    expect(await shouldRemindArchiveExport(repo, NOW)).toBe(false);
  });

  it("reminds when content exists and no export was recorded", async () => {
    const { repo } = repoStub({ lists: 1 });
    expect(await shouldRemindArchiveExport(repo, NOW)).toBe(true);
  });

  it("posts alone count as content worth archiving", async () => {
    const { repo } = repoStub({ posts: 1 });
    expect(await shouldRemindArchiveExport(repo, NOW)).toBe(true);
  });

  it("a recent export silences it; a stale one re-arms it", async () => {
    const { repo } = repoStub({ lists: 1 });
    await recordArchiveExport(repo, "2026-07-20T00:00:00.000Z");
    expect(await shouldRemindArchiveExport(repo, NOW)).toBe(false);
    const { repo: stale } = repoStub({ lists: 1 });
    await recordArchiveExport(stale, "2026-06-01T00:00:00.000Z");
    expect(await shouldRemindArchiveExport(stale, NOW)).toBe(true);
  });

  it("an unparseable or future timestamp is not a usable export record", async () => {
    const { repo } = repoStub({ lists: 1 });
    await recordArchiveExport(repo, "garbage");
    expect(await shouldRemindArchiveExport(repo, NOW)).toBe(true);
    const { repo: future } = repoStub({ lists: 1 });
    await recordArchiveExport(future, "2027-01-01T00:00:00.000Z");
    expect(await shouldRemindArchiveExport(future, NOW)).toBe(true);
  });
});
