/**
 * Client-side image import: type/size check + downscale/re-encode to WebP where the
 * platform supports it (canvas re-encode also strips EXIF/location metadata — the
 * privacy half of book/src/notes.md). Falls back to the original bytes where
 * OffscreenCanvas is unavailable (tests, old browsers).
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
      return { blob: file, mime: file.type as ImportedImage["mime"] };
    }
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { blob: file, mime: file.type as ImportedImage["mime"] };
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
    return { blob, mime: "image/webp", width, height };
  } catch {
    return { blob: file, mime: file.type as ImportedImage["mime"] };
  }
}
