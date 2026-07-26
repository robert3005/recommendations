/**
 * URL shapes taken from what the three apps actually put on the clipboard.
 */
import { describe, expect, it } from "vitest";
import { linkIsActionable, parsePlaceLink, placeLinksFor } from "./placeLinks";

describe("parsePlaceLink — Google Maps", () => {
  it("prefers the pin's own coordinates over the camera centre", () => {
    // `@` is wherever the map was; `!3d!4d` is the place itself. They differ.
    const link = parsePlaceLink(
      "https://www.google.com/maps/place/Cervejaria+Ramiro/@38.7208,-9.1350,17z/data=!4m6!3m5!1s0x1f9a2b:0xdeadbeef!8m2!3d38.7207!4d-9.1352",
    );
    expect(link?.provider).toBe("google-maps");
    expect(link?.coords).toEqual({ lat: 38.7207, lng: -9.1352 });
    expect(link?.name).toBe("Cervejaria Ramiro");
    expect(link?.fid).toBe("0x1f9a2b:0xdeadbeef");
    expect(linkIsActionable(link!)).toBe(true);
  });

  it("falls back to the camera centre when the URL carries nothing better", () => {
    const link = parsePlaceLink("https://www.google.com/maps/@51.5074,-0.1278,14z");
    expect(link?.coords).toEqual({ lat: 51.5074, lng: -0.1278 });
    expect(link?.name).toBeUndefined();
  });

  it("reads a dropped pin and a cid listing", () => {
    expect(parsePlaceLink("https://www.google.com/maps/search/38.72,-9.14")?.coords).toEqual({
      lat: 38.72,
      lng: -9.14,
    });
    expect(parsePlaceLink("https://maps.google.com/?cid=123456")?.fid).toBe("cid:123456");
  });

  it("does not mistake a coordinate pair in the name slot for a name", () => {
    const link = parsePlaceLink("https://www.google.com/maps/place/38.72,-9.14/@38.72,-9.14,17z");
    expect(link?.name).toBeUndefined();
  });

  it("flags a share-sheet short link instead of failing silently", () => {
    const link = parsePlaceLink("https://maps.app.goo.gl/aBcDeFgHiJk");
    expect(link?.needsExpansion).toBe(true);
    // Nothing to place a pin with, so the UI must ask rather than guess.
    expect(linkIsActionable(link!)).toBe(false);
  });
});

describe("parsePlaceLink — OpenStreetMap", () => {
  it("reads a typed element, which is the case worth having", () => {
    const link = parsePlaceLink("https://www.openstreetmap.org/node/240109189");
    expect(link?.provider).toBe("openstreetmap");
    // A real element resolves to copied evidence, not just a coordinate.
    expect(link?.osmRef).toEqual({ type: "node", id: "240109189" });
    expect(linkIsActionable(link!)).toBe(true);
  });

  it("reads a marker link and the map hash", () => {
    expect(
      parsePlaceLink("https://www.openstreetmap.org/?mlat=51.5074&mlon=-0.1278#map=17/51.5/-0.12")
        ?.coords,
    ).toEqual({ lat: 51.5074, lng: -0.1278 });
    expect(parsePlaceLink("https://www.openstreetmap.org/#map=17/38.7207/-9.1352")?.coords).toEqual(
      {
        lat: 38.7207,
        lng: -9.1352,
      },
    );
  });

  it("keeps the element ref even when the URL also carries a hash", () => {
    const link = parsePlaceLink("https://www.openstreetmap.org/way/12345#map=19/38.72/-9.13");
    expect(link?.osmRef).toEqual({ type: "way", id: "12345" });
  });
});

describe("parsePlaceLink — Apple Maps", () => {
  it("reads coordinates and a query name", () => {
    const link = parsePlaceLink("https://maps.apple.com/?ll=38.7207,-9.1352&q=Cervejaria%20Ramiro");
    expect(link?.provider).toBe("apple-maps");
    expect(link?.coords).toEqual({ lat: 38.7207, lng: -9.1352 });
    expect(link?.name).toBe("Cervejaria Ramiro");
  });

  it("does not take a coordinate pair in q as a name, and falls back to address", () => {
    expect(parsePlaceLink("https://maps.apple.com/?ll=1,2&q=1,2")?.name).toBeUndefined();
    // URLSearchParams decodes `+` as a space, so the address arrives readable.
    expect(parsePlaceLink("https://maps.apple.com/?ll=1,2&address=Rua+das+Flores")?.name).toBe(
      "Rua das Flores",
    );
  });
});

describe("parsePlaceLink — rejection", () => {
  it.each([
    "",
    "not a url",
    "coffee near me",
    "javascript:alert(1)",
    "https://example.com/maps/place/Somewhere",
    "https://not-google.com/maps/@1,2,3z",
  ])("returns undefined for %j", (input) => {
    expect(parsePlaceLink(input)).toBeUndefined();
  });

  it("refuses coordinates outside the world", () => {
    expect(parsePlaceLink("https://www.openstreetmap.org/?mlat=91&mlon=0")?.coords).toBeUndefined();
  });
});

describe("placeLinksFor", () => {
  it("reopens the exact Google listing when one was retained", () => {
    const links = placeLinksFor({
      lat: 38.72,
      lng: -9.14,
      name: "Ramiro",
      externalUrl: "https://www.google.com/maps/place/Ramiro/data=!4m2!3m1!1s0x1f:0x2a",
    });
    expect(links.google).toContain("/maps/place/Ramiro");
  });

  it("ignores a stored URL that is not a Google host", () => {
    const links = placeLinksFor({
      lat: 38.72,
      lng: -9.14,
      externalUrl: "https://evil.example/steal",
    });
    expect(links.google).toContain("google.com/maps/search");
    expect(links.google).not.toContain("evil.example");
  });

  it("gives an OSM portal link only for a place bound to an element", () => {
    expect(placeLinksFor({ lat: 1, lng: 2 }).osm).toBeUndefined();
    expect(placeLinksFor({ lat: 1, lng: 2, osmRef: { type: "node", id: "7" } }).osm).toBe(
      "https://www.openstreetmap.org/node/7",
    );
  });

  it("always produces a working Apple link", () => {
    expect(placeLinksFor({ lat: 38.72, lng: -9.14, name: "Ramiro" }).apple).toBe(
      "https://maps.apple.com/?ll=38.72,-9.14&q=Ramiro",
    );
  });
});
