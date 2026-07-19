import { describe, expect, it } from "vitest";
import {
  assembleAddress,
  deriveCategory,
  identityTagsFrom,
  normalizePhone,
  normalizeWebsite,
  resolvedPoiFromTags,
  websiteFromTags,
} from "./poi";

describe("websiteFromTags", () => {
  it("prefers website over contact:website over url", () => {
    expect(
      websiteFromTags({
        website: "https://primary.example",
        "contact:website": "https://secondary.example",
        url: "https://tertiary.example",
      }),
    ).toBe("https://primary.example/");
    expect(
      websiteFromTags({
        "contact:website": "https://secondary.example",
        url: "https://tertiary.example",
      }),
    ).toBe("https://secondary.example/");
    expect(websiteFromTags({ url: "https://tertiary.example" })).toBe("https://tertiary.example/");
  });

  it("falls through invalid values to the next key", () => {
    expect(websiteFromTags({ website: "javascript:alert(1)", url: "cafe.example" })).toBe(
      "https://cafe.example/",
    );
  });
});

describe("normalizeWebsite", () => {
  it("adds https to scheme-less domains", () => {
    expect(normalizeWebsite("cafecentral.pt")).toBe("https://cafecentral.pt/");
    expect(normalizeWebsite("  cafecentral.pt/menu ")).toBe("https://cafecentral.pt/menu");
  });
  it("upgrades protocol-relative URLs", () => {
    expect(normalizeWebsite("//cafe.example")).toBe("https://cafe.example/");
  });
  it("keeps http", () => {
    expect(normalizeWebsite("http://cafe.example")).toBe("http://cafe.example/");
  });
  it("rejects non-http(s) schemes — untrusted data never becomes a link", () => {
    expect(normalizeWebsite("javascript:alert(1)")).toBeUndefined();
    expect(normalizeWebsite("ftp://files.example")).toBeUndefined();
    expect(normalizeWebsite("data:text/html,x")).toBeUndefined();
  });
  it("rejects junk", () => {
    expect(normalizeWebsite("")).toBeUndefined();
    expect(normalizeWebsite("   ")).toBeUndefined();
    expect(normalizeWebsite("no")).toBeUndefined();
  });
});

describe("deriveCategory", () => {
  it("uses the primary feature tag in documented order", () => {
    expect(deriveCategory({ amenity: "cafe", shop: "bakery" })).toBe("cafe");
    expect(deriveCategory({ shop: "bakery" })).toBe("bakery");
    expect(deriveCategory({ tourism: "museum" })).toBe("museum");
    expect(deriveCategory({ building: "yes" })).toBe("place");
  });
});

describe("assembleAddress", () => {
  it("assembles from addr:* tags", () => {
    expect(
      assembleAddress({
        "addr:street": "Rua Example",
        "addr:housenumber": "12",
        "addr:postcode": "1100-000",
        "addr:city": "Lisboa",
      }),
    ).toBe("Rua Example 12, Lisboa 1100-000");
  });
  it("handles partial data", () => {
    expect(assembleAddress({ "addr:city": "Lisboa" })).toBe("Lisboa");
    expect(assembleAddress({})).toBeUndefined();
  });
});

describe("normalizePhone", () => {
  it("reduces to comparable digits", () => {
    expect(normalizePhone("+351 21 000 0000")).toBe("+351210000000");
    expect(normalizePhone("(21) 000-0000")).toBe("210000000");
  });
  it("rejects too-short values", () => {
    expect(normalizePhone("12")).toBeUndefined();
  });
});

describe("identityTagsFrom", () => {
  it("keeps a bounded matching subset, not an unfiltered copy", () => {
    const tags: Record<string, string> = {
      name: "Café Central",
      wikidata: "Q1",
      amenity: "cafe",
      website: "https://cafe.example",
      "addr:street": "Rua Example",
      irrelevant: "x",
    };
    for (let i = 0; i < 40; i++) tags[`filler:${i}`] = "y";
    const picked = identityTagsFrom(tags);
    expect(picked.name).toBe("Café Central");
    expect(picked.wikidata).toBe("Q1");
    expect(picked.amenity).toBe("cafe");
    expect(picked.irrelevant).toBeUndefined();
    expect(Object.keys(picked).length).toBeLessThanOrEqual(24);
  });
  it("keeps ref:* identifiers", () => {
    expect(identityTagsFrom({ "ref:vatin": "PT123" })["ref:vatin"]).toBe("PT123");
  });
});

describe("resolvedPoiFromTags", () => {
  it("builds the full display surface", () => {
    const poi = resolvedPoiFromTags({
      ref: { type: "node", id: "1" },
      tags: {
        name: "Café Central",
        amenity: "cafe",
        website: "cafecentral.pt",
        phone: "+351 21 000 0000",
        opening_hours: "Mo-Fr 08:00-18:00",
        "addr:street": "Rua Example",
        "addr:housenumber": "12",
      },
      lat: 38.7139,
      lng: -9.1394,
      osmVersion: 3,
      resolvedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(poi.name).toBe("Café Central");
    expect(poi.category).toBe("cafe");
    expect(poi.website).toBe("https://cafecentral.pt/");
    expect(poi.openingHours).toBe("Mo-Fr 08:00-18:00");
    expect(poi.address).toBe("Rua Example 12");
    expect(poi.identityTags.name).toBe("Café Central");
  });
});
