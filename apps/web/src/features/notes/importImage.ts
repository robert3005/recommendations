/**
 * Client-side image import: type/size check + downscale/re-encode to WebP.
 * The canvas re-encode strips EXIF/location metadata — the privacy half of
 * book/src/notes.md. Where no re-encode path exists, the import is REJECTED:
 * retaining the original bytes (and their embedded location) is never safe.
 */
const MAX_DIMENSION = 1600;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface ImportedImage {
  blob: Blob;
  mime: "image/jpeg" | "image/png" | "image/webp";
  width?: number;
  height?: number;
}

export async function importImage(file: File): Promise<ImportedImage | undefined> {
  if (!ACCEPTED.has(file.type) || file.size > MAX_BYTES) return undefined;
  try {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
      return undefined;
    }
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
    return { blob, mime: "image/webp", width, height };
  } catch {
    return undefined;
  }
}
