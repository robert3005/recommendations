import { describe, expect, it } from "vitest";
import {
  harvestManifestSchema,
  harvestPhotoSchema,
  harvestReviewSchema,
  placeDirName,
  placeSnapshotSchema,
  sourcePlaceKeySchema,
} from "./harvest";

const fetchedAt = "2026-11-21T00:00:00.000Z";

describe("harvest dataset schemas", () => {
  it("accepts Google feature ids and cids as place keys, lowercase only", () => {
    expect(sourcePlaceKeySchema.safeParse("0x47e66e2964e34e2d:0x8ddca9ee380ef7e0").success).toBe(
      true,
    );
    expect(sourcePlaceKeySchema.safeParse("cid:10222232094831998944").success).toBe(true);
    expect(sourcePlaceKeySchema.safeParse("ChIJLU7jZClu5kcR4PcOOO6p3I0").success).toBe(false);
    expect(sourcePlaceKeySchema.safeParse("0xABC:0xDEF").success).toBe(false);
  });

  it("maps place keys to file-system-safe directory names", () => {
    expect(placeDirName("0x1a:0x2b")).toBe("0x1a_0x2b");
    expect(placeDirName("cid:123")).toBe("cid_123");
  });

  it("validates a minimal place snapshot", () => {
    const place = placeSnapshotSchema.parse({
      sourcePlaceKey: "0x1a:0x2b",
      name: "Bar Douro",
      lat: 51.5,
      lng: -0.09,
      types: ["Portuguese restaurant"],
      provider: "gosom",
      fetchedAt,
    });
    expect(place.name).toBe("Bar Douro");
  });

  it("validates a review and rejects ratings outside 1–5", () => {
    const review = {
      id: "rev_1",
      sourcePlaceKey: "0x1a:0x2b",
      source: "google",
      sourceReviewId: "ChdDSUhN",
      rating: 5,
      text: "Excellent",
      provider: "gosom",
      fetchedAt,
      contentHash: "a".repeat(64),
    };
    expect(harvestReviewSchema.safeParse(review).success).toBe(true);
    expect(harvestReviewSchema.safeParse({ ...review, rating: 6 }).success).toBe(false);
  });

  it("requires a photo to have a url or a local path, and attribution", () => {
    const photo = {
      id: "pho_1",
      sourcePlaceKey: "0x1a:0x2b",
      attribution: { name: "A. Diner" },
      source: "google",
      provider: "gosom",
      fetchedAt,
    };
    expect(harvestPhotoSchema.safeParse(photo).success).toBe(false);
    expect(
      harvestPhotoSchema.safeParse({ ...photo, url: "https://lh3.googleusercontent.com/x" }).success,
    ).toBe(true);
  });

  it("validates an empty manifest", () => {
    expect(
      harvestManifestSchema.safeParse({ schemaVersion: 1, createdAt: fetchedAt, runs: [] }).success,
    ).toBe(true);
  });
});
