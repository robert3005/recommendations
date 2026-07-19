/**
 * The chosen image pipeline in spec/src/tech-stack.md re-encodes imports so
 * EXIF/location metadata cannot survive. If a browser cannot safely re-encode,
 * rejecting the image is safer than retaining the original bytes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { importImage } from "./importImage";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Phase 0 image-import privacy", () => {
  it("never accepts the original JPEG when a re-encode path is unavailable", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    vi.stubGlobal("OffscreenCanvas", undefined);
    const original = new File(["fake-jpeg-with-location-exif"], "photo.jpg", {
      type: "image/jpeg",
    });

    const outcome = await importImage(original).then(
      (imported) => ({ imported }),
      (error: unknown) => ({ error }),
    );

    // Safe outcomes are a WebP re-encode through another implementation or a
    // rejected import. Passing the source JPEG through is never safe.
    if ("error" in outcome) {
      expect(outcome.error).toBeDefined();
    } else {
      expect(outcome.imported === undefined || outcome.imported.mime === "image/webp").toBe(true);
      expect(outcome.imported?.blob).not.toBe(original);
    }
  });
});
