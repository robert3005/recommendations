import { describe, expect, it } from "vitest";
import type { GeocoderCandidate } from "./entities";
import { autoPlaceDecision, normalizeName } from "./ladder";

const ramiro: GeocoderCandidate = {
  name: "Cervejaria Ramiro",
  lat: 38.7207,
  lng: -9.1352,
  address: "Avenida Almirante Reis 1, 1150-007 Lisboa",
  osmRef: { type: "node", id: "240109189" },
};

describe("normalizeName", () => {
  it("folds case and collapses punctuation, keeping letters of any script", () => {
    expect(normalizeName("Cervejaria — RAMIRO!")).toBe("cervejaria ramiro");
    expect(normalizeName("  Café  São João ")).toBe("café são joão");
    expect(normalizeName("...")).toBe("");
  });
});

describe("autoPlaceDecision", () => {
  it("auto-places a single candidate with a matching name — and hands back its osmRef", () => {
    const decision = autoPlaceDecision({ title: "cervejaria ramiro" }, [ramiro]);
    expect(decision).toEqual({ kind: "auto", candidate: ramiro });
  });

  it("sends multiple candidates to review, even when the first matches", () => {
    expect(
      autoPlaceDecision({ title: "Cervejaria Ramiro" }, [ramiro, { ...ramiro, lat: 38.9 }]),
    ).toEqual({ kind: "review" });
  });

  it("sends no result to review — an empty answer is a miss, not an error", () => {
    expect(autoPlaceDecision({ title: "Cervejaria Ramiro" }, [])).toEqual({ kind: "review" });
  });

  it("sends a name mismatch to review", () => {
    expect(autoPlaceDecision({ title: "Ramiro" }, [ramiro])).toEqual({ kind: "review" });
    expect(autoPlaceDecision({ title: "" }, [ramiro])).toEqual({ kind: "review" });
  });

  it("treats conflicting street numbers as a contradiction", () => {
    const decision = autoPlaceDecision(
      { title: "Cervejaria Ramiro", address: "Avenida Almirante Reis 14" },
      [ramiro],
    );
    expect(decision).toEqual({ kind: "review" });
  });

  it("does not treat formatting differences as a contradiction", () => {
    // "1" appears in both — differing formats around it are not a conflict.
    const decision = autoPlaceDecision(
      { title: "Cervejaria Ramiro", address: "Av. Almirante Reis, 1" },
      [ramiro],
    );
    expect(decision).toEqual({ kind: "auto", candidate: ramiro });
  });

  it("never lets a missing address block auto-placement", () => {
    expect(autoPlaceDecision({ title: "Cervejaria Ramiro" }, [ramiro])).toEqual({
      kind: "auto",
      candidate: ramiro,
    });
    const bare = { ...ramiro };
    delete (bare as { address?: string }).address;
    expect(
      autoPlaceDecision({ title: "Cervejaria Ramiro", address: "somewhere 12" }, [bare]),
    ).toEqual({ kind: "auto", candidate: bare });
  });
});
