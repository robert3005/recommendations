import { describe, expect, it } from "vitest";
import { classifyCandidates, isHighConfidence, scoreCandidate } from "./match";
import type { OsmEvidence } from "./place";
import type { ResolvedPoi } from "./poi";

function evidence(overrides: Partial<OsmEvidence> = {}): OsmEvidence {
  return {
    ref: { type: "node", id: "1" },
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    website: "https://cafecentral.pt/",
    identityTags: { name: "Café Central", amenity: "cafe", website: "https://cafecentral.pt/" },
    observedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function candidate(overrides: Partial<ResolvedPoi> = {}): ResolvedPoi {
  return {
    osmRef: { type: "way", id: "99" },
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    website: "https://cafecentral.pt/",
    identityTags: { name: "Café Central", amenity: "cafe", website: "https://cafecentral.pt/" },
    resolvedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("scoreCandidate", () => {
  it("distance alone never reaches high confidence", () => {
    const stranger = candidate({
      name: "Totally Different Bar",
      category: "bar",
      website: undefined,
      identityTags: { name: "Totally Different Bar", amenity: "bar" },
    });
    const scored = scoreCandidate(evidence(), stranger);
    expect(scored.hasIdentitySignal).toBe(false);
    expect(isHighConfidence(scored)).toBe(false);
  });

  it("wikidata is a strong identity signal", () => {
    const ev = evidence({ identityTags: { wikidata: "Q123", name: "Café Central" } });
    const scored = scoreCandidate(
      ev,
      candidate({ identityTags: { wikidata: "Q123", name: "Renamed Café" }, name: "Renamed Café" }),
    );
    expect(scored.reasons).toContain("strong-id:wikidata");
    expect(isHighConfidence(scored)).toBe(true);
  });

  it("website domain match ignores www and paths", () => {
    const scored = scoreCandidate(
      evidence({ website: "https://www.cafecentral.pt/" }),
      candidate({ website: "https://cafecentral.pt/menu" }),
    );
    expect(scored.reasons).toContain("website-domain");
  });

  it("penalizes far-away candidates", () => {
    const far = candidate({ lat: 39.5, lng: -9.1394 }); // ~87 km away
    const scored = scoreCandidate(evidence(), far);
    expect(scored.reasons).toContain("distance>2km");
    expect(isHighConfidence(scored)).toBe(false);
  });
});

describe("classifyCandidates", () => {
  it("one unique high-confidence candidate → auto", () => {
    const result = classifyCandidates(evidence(), [
      candidate(),
      candidate({
        osmRef: { type: "node", id: "500" },
        name: "Random Kiosk",
        category: "kiosk",
        website: undefined,
        identityTags: { name: "Random Kiosk" },
      }),
    ]);
    expect(result.kind).toBe("auto");
    if (result.kind === "auto") expect(result.best.candidate.osmRef.id).toBe("99");
  });

  it("two high-confidence candidates → review, never a silent pick", () => {
    const result = classifyCandidates(evidence(), [
      candidate({ osmRef: { type: "node", id: "7" } }),
      candidate({ osmRef: { type: "way", id: "8" } }),
    ]);
    expect(result.kind).toBe("review");
  });

  it("nothing plausible → none", () => {
    const result = classifyCandidates(evidence(), [
      candidate({
        osmRef: { type: "node", id: "3" },
        name: "Laundromat",
        category: "laundry",
        website: undefined,
        lat: 40.0,
        identityTags: { name: "Laundromat" },
      }),
    ]);
    expect(result.kind).toBe("none");
  });
});
