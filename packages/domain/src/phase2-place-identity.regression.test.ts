import { describe, expect, it } from "vitest";
import { createOsmPlace, evidenceFromPoi } from "./place";
import type { ResolvedPoi } from "./poi";
import { applyRecovery } from "./resolution";

const FIRST = "2026-07-01T12:00:00.000Z";
const LAST = "2026-07-18T12:00:00.000Z";
const RECOVERED = "2026-07-19T12:00:00.000Z";

function poi(overrides: Partial<ResolvedPoi> = {}): ResolvedPoi {
  return {
    osmRef: { type: "node", id: "101" },
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name: "Café Central", wikidata: "Q123" },
    resolvedAt: FIRST,
    ...overrides,
  };
}

describe("Phase 2 durable recovery evidence", () => {
  it("can recover from immutable first-seen evidence when the latest observation lost its stable id", () => {
    const created = createOsmPlace("place-1", poi(), FIRST);
    const place = {
      ...created,
      // A plausible in-place upstream change may remove a stable identifier. That
      // must not erase the immutable evidence retained specifically for recovery.
      lastVerified: evidenceFromPoi(
        poi({
          name: "New café name",
          identityTags: { name: "New café name" },
          resolvedAt: LAST,
        }),
      ),
    };
    const replacement = poi({
      osmRef: { type: "way", id: "202" },
      resolvedAt: RECOVERED,
    });

    const result = applyRecovery(place, [replacement], RECOVERED);

    expect(result.resolutionState).toBe("resolved");
    expect(result.currentOsmRef).toEqual({ type: "way", id: "202" });
    expect(result.id).toBe("place-1");
  });
});
