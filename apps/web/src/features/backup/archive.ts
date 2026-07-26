/**
 * Archive primitives for the ZIP backup format (spec/src/storage-sync.md
 * §Backup and restore): byte access, checksums, the import resource caps, and
 * the central-directory read that lets a hostile archive be refused before any
 * of it is inflated.
 */

/** Blob → bytes with a FileReader fallback (jsdom Blobs may lack arrayBuffer()). */
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Import resource caps (spec/src/storage-sync.md: archive bytes, entry count, inflated bytes). */
export const ARCHIVE_BYTE_LIMIT = 256 * 1024 * 1024;
export const ARCHIVE_ENTRY_LIMIT = 4096;
export const INFLATED_BYTE_LIMIT = 48 * 1024 * 1024;

/** The ZIP end-of-central-directory record, scanned from the tail. */
export function findEocd(bytes: Uint8Array): number {
  const scanFrom = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= scanFrom; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) +
  (bytes[at + 3] ?? 0) * 0x1000000;

/**
 * The bounds the ZIP central directory itself declares — parsed strictly and
 * BEFORE any decompression. A directory that cannot be walked as declared is
 * "invalid", never interpreted as declaring zero.
 */
export function declaredZipDirectory(
  bytes: Uint8Array,
): { entryCount: number; inflatedTotal: number } | "invalid" {
  const eocd = findEocd(bytes);
  // No end-of-central-directory record means no declared bounds to trust.
  if (eocd < 0) return "invalid";
  const entryCount = u16(bytes, eocd + 10);
  const declaredSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  let offset = cdOffset;
  let inflatedTotal = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) return "invalid";
    inflatedTotal += u32(bytes, offset + 24);
    offset += 46 + u16(bytes, offset + 28) + u16(bytes, offset + 30) + u16(bytes, offset + 32);
  }
  // Every EOCD declaration must agree with the walk: the record count must
  // consume exactly the declared central-directory span ending at the EOCD.
  if (offset !== eocd || offset - cdOffset !== declaredSize) return "invalid";
  return { entryCount, inflatedTotal };
}
