/**
 * Mode A — snapshot links (spec/src/sharing.md): the SharedGuide compressed
 * into the URL fragment. No backend receives the document; explicit compressed
 * and inflated byte limits guard generation and decoding (decompression-bomb
 * protection); the decoder schema-validates before anything renders.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { sharedGuideSchema } from "@placemarks/schemas";
import { deflateSync, Inflate, strFromU8, strToU8 } from "fflate";

/** Fragment budget: keeps the whole URL comfortably shareable. */
export const SNAPSHOT_COMPRESSED_LIMIT = 49_152;
/** Decompression cap: nothing legitimate approaches this. */
export const SNAPSHOT_INFLATED_LIMIT = 1_048_576;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): Uint8Array {
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class SnapshotTooLargeError extends Error {
  constructor(readonly compressedBytes: number) {
    super(
      `this guide compresses to ${Math.ceil(compressedBytes / 1024)} KiB — over the ` +
        `${SNAPSHOT_COMPRESSED_LIMIT / 1024} KiB snapshot-link limit. Use a hosted link instead.`,
    );
  }
}

/** Encode a guide for the `/l#…` fragment. Never silently truncates. */
export function encodeSnapshot(guide: SharedGuide): { fragment: string; compressedBytes: number } {
  const json = strToU8(JSON.stringify(guide));
  // The generator must never hand out a link its own decoder would refuse.
  if (json.byteLength > SNAPSHOT_INFLATED_LIMIT) {
    throw new Error(
      `this guide is ${Math.ceil(json.byteLength / 1024)} KiB uncompressed — over the ` +
        `${SNAPSHOT_INFLATED_LIMIT / 1024} KiB snapshot decoder limit. Use a hosted link instead.`,
    );
  }
  const compressed = deflateSync(json, { level: 9 });
  if (compressed.length > SNAPSHOT_COMPRESSED_LIMIT) {
    throw new SnapshotTooLargeError(compressed.length);
  }
  return { fragment: toBase64Url(compressed), compressedBytes: compressed.length };
}

/** Decode and validate a fragment. Throws on anything malformed or oversized. */
export function decodeSnapshot(fragment: string): SharedGuide {
  if (fragment.length === 0) throw new Error("the link carries no shared guide");
  if (fragment.length > SNAPSHOT_COMPRESSED_LIMIT * 2) {
    throw new Error("shared link is too large to be genuine");
  }
  let inflated: Uint8Array;
  try {
    const compressed = fromBase64Url(fragment);
    // The generation-side byte limit binds on decode too — an inbound link
    // larger than anything we would generate is not genuine.
    if (compressed.length > SNAPSHOT_COMPRESSED_LIMIT) {
      throw new Error("shared link exceeds the compressed-size limit");
    }
    // Streaming inflate with a running byte count caps decompression work.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const inflater = new Inflate((chunk) => {
      total += chunk.length;
      if (total > SNAPSHOT_INFLATED_LIMIT) {
        throw new Error("shared link inflates beyond the safe limit");
      }
      chunks.push(chunk);
    });
    inflater.push(compressed, true);
    inflated = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      inflated.set(chunk, offset);
      offset += chunk.length;
    }
  } catch (err) {
    if (err instanceof Error && /shared link|size limit/.test(err.message)) throw err;
    throw new Error("this shared link is damaged and cannot be opened");
  }
  const parsed = sharedGuideSchema.safeParse(JSON.parse(strFromU8(inflated)));
  if (!parsed.success) throw new Error("this link is not a valid shared guide");
  return parsed.data;
}
