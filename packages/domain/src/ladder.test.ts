import { describe, expect, it } from "vitest";
import type { GeocoderCandidate } from "./entities";
import { autoPlaceDecision, listBias, normalizeName } from "./ladder";

const ramiro: GeocoderCandidate = {
  name: "Cervejaria Ramiro",
  lat: 38.7207,
  lng: -9.1352,
  address: "Avenida Almirante Reis 1, 1150-007 Lisboa",
  osmRef: { type: "node", id: "240109189" },
};

describe("normalizeName", () => {
  it("folds case and accents and collapses punctuation, keeping letters of any script", () => {
    expect(normalizeName("Cervejaria — RAMIRO!")).toBe("cervejaria ramiro");
    expect(normalizeName("  Café  São João ")).toBe("cafe sao joao");
    expect(normalizeName("Ресторан Пушкинъ")).toBe("ресторан пушкинъ");
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

describe("autoPlaceDecision — several results", () => {
  const ramiro = (address: string, lat = 38.72, lng = -9.135): GeocoderCandidate => ({
    name: "Cervejaria Ramiro",
    lat,
    lng,
    address,
    osmRef: { type: "node", id: "7" },
  });
  const other: GeocoderCandidate = { name: "Ramiro Bar", lat: 40.4, lng: -3.7, address: "Madrid" };

  it("auto-places the one result whose address corroborates the row's", () => {
    const decision = autoPlaceDecision(
      { title: "Cervejaria Ramiro", address: "Av. Almirante Reis 1 H, 1150-007 Lisboa" },
      [other, ramiro("Avenida Almirante Reis 1, Lisboa 1150-007")],
    );
    expect(decision).toMatchObject({ kind: "auto", candidate: { osmRef: { id: "7" } } });
  });

  it("corroborates on street and city words when neither address has a matching number", () => {
    const decision = autoPlaceDecision(
      { title: "Cervejaria Ramiro", address: "Avenida Almirante Reis, Lisboa" },
      [other, ramiro("Avenida Almirante Reis, Lisboa")],
    );
    expect(decision.kind).toBe("auto");
  });

  it("reviews a name match among several results when nothing corroborates it", () => {
    expect(autoPlaceDecision({ title: "Cervejaria Ramiro" }, [other, ramiro("Lisboa")]).kind).toBe(
      "review",
    );
  });

  it("reviews two corroborated matches — a tie is never auto-placed", () => {
    const row = { title: "Cervejaria Ramiro", address: "Avenida Almirante Reis 1, Lisboa" };
    const twin = ramiro("Avenida Almirante Reis 1, Lisboa");
    expect(
      autoPlaceDecision(row, [twin, { ...twin, osmRef: { type: "node", id: "8" } }]).kind,
    ).toBe("review");
  });

  it("auto-places the only match near the rest of the list when the row has no address", () => {
    const lisbon = ramiro("Lisboa");
    const porto = ramiro("Porto", 41.15, -8.61);
    const near = [{ lat: 38.71, lng: -9.14 }];
    expect(autoPlaceDecision({ title: "Cervejaria Ramiro" }, [porto, lisbon], { near })).toEqual({
      kind: "auto",
      candidate: lisbon,
    });
    // Two branches in the same city: still a tie.
    expect(
      autoPlaceDecision({ title: "Cervejaria Ramiro" }, [ramiro("Lisboa", 38.73, -9.15), lisbon], {
        near,
      }).kind,
    ).toBe("review");
  });

  it("accepts a row title that adds the candidate's own city to its name", () => {
    const market: GeocoderCandidate = {
      name: "Time Out Market",
      lat: 38.707,
      lng: -9.146,
      address: "Avenida 24 de Julho 49, Lisboa 1200-479",
    };
    expect(
      autoPlaceDecision({ title: "Time Out Market Lisboa", address: "Av. 24 de Julho 49" }, [
        market,
      ]).kind,
    ).toBe("auto");
    // The extra word must come from the candidate's address, not from anywhere.
    expect(autoPlaceDecision({ title: "Time Out Market Porto" }, [market]).kind).toBe("review");
  });

  it("an address contradiction still vetoes an otherwise corroborated-by-proximity match", () => {
    const near = [{ lat: 38.71, lng: -9.14 }];
    expect(
      autoPlaceDecision(
        { title: "Cervejaria Ramiro", address: "Rua Nova 99, Lisboa" },
        [other, ramiro("Avenida Almirante Reis 1, Lisboa")],
        { near },
      ).kind,
    ).toBe("review");
  });
});

describe("listBias", () => {
  it("is the middle of rows that sit together, and nothing for a far-flung list", () => {
    expect(listBias([])).toBeUndefined();
    expect(
      listBias([
        { lat: 38.7, lng: -9.1 },
        { lat: 38.8, lng: -9.2 },
      ]),
    ).toEqual({ lat: 38.75, lng: expect.closeTo(-9.15, 5) });
    expect(
      listBias([
        { lat: 38.7, lng: -9.1 },
        { lat: 51.5, lng: -0.1 },
      ]),
    ).toBeUndefined();
  });
});

describe("autoPlaceDecision — a longer name at the row's address", () => {
  const factory: GeocoderCandidate = {
    name: "Manteigaria - Fábrica de Pastéis de Nata",
    lat: 38.7107,
    lng: -9.1437,
    address: "Rua do Loreto 2, Lisboa",
  };
  const street: GeocoderCandidate = { name: "Rua do Loreto", lat: 38.71, lng: -9.144 };

  it("auto-places it when number and street both agree", () => {
    expect(
      autoPlaceDecision({ title: "Manteigaria", address: "Rua do Loreto 2, 1200-108 Lisboa" }, [
        factory,
        street,
      ]),
    ).toEqual({ kind: "auto", candidate: factory });
  });

  it("reviews it without an address to agree with, even as the only result", () => {
    expect(autoPlaceDecision({ title: "Manteigaria" }, [factory]).kind).toBe("review");
    expect(
      autoPlaceDecision({ title: "Manteigaria", address: "Rua Augusta 2, Lisboa" }, [factory]).kind,
    ).toBe("review");
  });
});

describe("autoPlaceDecision — accents and listings repeated across sources", () => {
  const anchor = [{ lat: 51.52, lng: -0.1 }];

  it("matches a name whatever the accents", () => {
    const zedel: GeocoderCandidate = { name: "Brasserie Zedel", lat: 51.5103, lng: -0.1355 };
    const venue: GeocoderCandidate = { name: "Live at Zédel", lat: 51.5103, lng: -0.1356 };
    expect(
      autoPlaceDecision({ title: "Brasserie Zédel" }, [zedel, venue], { near: anchor }),
    ).toEqual({ kind: "auto", candidate: zedel });
  });

  it("treats the same name a few metres apart as one venue, keeping the OSM copy", () => {
    const foursquare: GeocoderCandidate = { name: "Andrew Edmunds", lat: 51.5128, lng: -0.1376 };
    const osm: GeocoderCandidate = {
      name: "Andrew Edmunds",
      lat: 51.51282,
      lng: -0.13762,
      osmRef: { type: "node", id: "1" },
    };
    expect(autoPlaceDecision({ title: "Andrew Edmunds" }, [foursquare, osm])).toEqual({
      kind: "auto",
      candidate: osm,
    });
  });

  it("still reviews two same-named places in different streets", () => {
    const a: GeocoderCandidate = { name: "Gymkhana", lat: 51.5095, lng: -0.1424 };
    const b: GeocoderCandidate = { name: "Gymkhana", lat: 51.55, lng: -0.3 };
    expect(autoPlaceDecision({ title: "Gymkhana" }, [a, b], { near: anchor }).kind).toBe("review");
  });
});
