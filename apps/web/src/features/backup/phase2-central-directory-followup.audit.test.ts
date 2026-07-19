/** The authoritative backup contract requires declared central-directory
 * bounds to be validated before any decompression begins. A broken directory
 * cannot safely be interpreted as declaring zero inflated bytes. */
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  return { ...actual, unzipSync: vi.fn(actual.unzipSync) };
});

const NOW = "2026-07-19T12:00:00.000Z";

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function breakCentralDirectoryOffset(bytes: Uint8Array): Uint8Array {
  const forged = bytes.slice();
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  for (let offset = forged.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    // Point the EOCD beyond the archive while retaining a plausible entry
    // count. A fail-open scanner reports zero rather than rejecting it.
    view.setUint32(offset + 16, forged.length + 1024, true);
    return forged;
  }
  throw new Error("EOCD fixture is missing");
}

describe("Phase 2 pre-decompression central-directory validation", () => {
  it("rejects an invalid declared directory before invoking unzip", async () => {
    const source = new DexieRepository(`phase2-central-dir-source-${crypto.randomUUID()}`);
    const target = new DexieRepository(`phase2-central-dir-target-${crypto.randomUUID()}`);
    try {
      const forged = breakCentralDirectoryOffset(await bytesOf(await exportBackup(source, NOW)));
      const unzip = vi.mocked(unzipSync);
      unzip.mockClear();
      let decompressionStarted = false;
      unzip.mockImplementationOnce(() => {
        decompressionStarted = true;
        throw new Error("unsafe decompression was invoked");
      });

      await expect(
        importBackup(
          target,
          new Blob([forged.slice().buffer as ArrayBuffer], { type: "application/zip" }),
          "replace",
          NOW,
        ),
      ).rejects.toThrow(/central|directory|archive|zip|valid/i);
      expect(decompressionStarted).toBe(false);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});
