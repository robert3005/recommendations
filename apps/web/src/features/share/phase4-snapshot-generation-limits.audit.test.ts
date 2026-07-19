import type { SharedGuide } from "@placemarks/schemas";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { encodeSnapshot, SNAPSHOT_INFLATED_LIMIT } from "./snapshot";

describe("Phase 4 snapshot generation limits", () => {
  it("refuses an inflated payload over the decoder limit even when it compresses well", () => {
    const guide: SharedGuide = {
      v: 1,
      title: "Highly compressible guide",
      blocks: Array.from({ length: 17 }, (_, index) => ({
        id: `section-${index.toString()}`,
        type: "section" as const,
        note: { body: "x".repeat(65_536) },
      })),
      contentHash: "hash",
    };

    expect(strToU8(JSON.stringify(guide)).byteLength).toBeGreaterThan(SNAPSHOT_INFLATED_LIMIT);

    // A generator must never hand the user a link its own decoder rejects.
    expect(() => encodeSnapshot(guide)).toThrow();
  });
});
