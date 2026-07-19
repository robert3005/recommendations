/** A successful backup export must never produce an archive its own restore refuses. */
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, INFLATED_BYTE_LIMIT, importBackup } from "./backup";

const NOW = "2026-07-19T13:00:00.000Z";

describe("Phase 6 backup export/import resource compatibility", () => {
  it("either refuses an oversized export up front or emits a restorable archive", async () => {
    const target = new DexieRepository(`phase6-large-export-target-${crypto.randomUUID()}`);
    const mediaBytes = new Uint8Array(INFLATED_BYTE_LIMIT + 1);
    const emptyTable = { toArray: async () => [] };
    const mediaAssets = [
      {
        id: "large-media",
        mime: "image/webp",
        localBlobKey: "large-media.webp",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    // Keep the large fixture out of IndexedDB/jsdom's Blob bridge: export
    // depends only on this repository-shaped read boundary.
    const source = {
      db: {
        places: emptyTable,
        tags: emptyTable,
        tagAssignments: emptyTable,
        notes: emptyTable,
        mediaAssets: { toArray: async () => mediaAssets },
        lists: emptyTable,
        listBlocks: emptyTable,
        blockNoteAttachments: emptyTable,
        mediaBlobs: {
          get: async () => ({
            blob: {
              arrayBuffer: async () => mediaBytes.buffer as ArrayBuffer,
            } as Blob,
          }),
        },
      },
    } as unknown as DexieRepository;
    try {
      let archive: Blob | undefined;
      try {
        archive = await exportBackup(source, NOW);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/size|large|limit/i);
        return;
      }

      await expect(importBackup(target, archive, "replace", NOW)).resolves.toMatchObject({
        mode: "replace",
      });
    } finally {
      target.db.close();
    }
  }, 30_000);
});
