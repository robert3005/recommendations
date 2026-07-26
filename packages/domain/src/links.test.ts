/**
 * URL shapes taken from what the three map apps actually put on the clipboard.
 */
import { describe, expect, it } from "vitest";
import { appleLink, googleFeatureId, googleLink, osmLink, parsePastedLink } from "./links";

describe("parsePastedLink — Google Maps", () => {
  it("prefers the pin's own coordinates (!3d/!4d) over the camera centre (@)", () => {
    // `@` is wherever the map was; `!3d!4d` is the place itself. They differ.
    const link = parsePastedLink(
      "https://www.google.com/maps/place/Cervejaria+Ramiro/@38.7208,-9.1350,17z/data=!4m6!3m5!1s0x1f9a2b:0xdeadbeef!8m2!3d38.7207!4d-9.1352",
    );
    expect(link).toEqual({
      kind: "google",
      lat: 38.7207,
      lng: -9.1352,
      name: "Cervejaria Ramiro",
      featureId: "0x1f9a2b:0xdeadbeef",
      url: "https://www.google.com/maps/place/Cervejaria+Ramiro/@38.7208,-9.1350,17z/data=!4m6!3m5!1s0x1f9a2b:0xdeadbeef!8m2!3d38.7207!4d-9.1352",
    });
  });

  it("falls back to the camera centre when the URL carries nothing better", () => {
    const link = parsePastedLink("https://www.google.com/maps/@51.5074,-0.1278,14z");
    expect(link?.kind).toBe("google");
    if (link?.kind !== "google") return;
    expect(link.lat).toBe(51.5074);
    expect(link.lng).toBe(-0.1278);
    expect(link.name).toBeUndefined();
  });

  it("reads a dropped pin, a q= pin, and a cid listing", () => {
    const pin = parsePastedLink("https://www.google.com/maps/search/38.72,-9.14");
    expect(pin?.kind === "google" && pin.lat).toBe(38.72);
    expect(pin?.kind === "google" && pin.lng).toBe(-9.14);

    const q = parsePastedLink("https://maps.google.com/?q=38.7,-9.1");
    expect(q?.kind === "google" && q.lat).toBe(38.7);

    const cid = parsePastedLink("https://maps.google.com/?cid=123456");
    expect(cid?.kind === "google" && cid.featureId).toBe("cid:123456");
  });

  it("does not mistake a coordinate pair in the name slot for a name", () => {
    const link = parsePastedLink("https://www.google.com/maps/place/38.72,-9.14/@38.72,-9.14,17z");
    expect(link?.kind === "google" && link.name).toBeUndefined();
  });

  it("refuses coordinates outside the world", () => {
    const link = parsePastedLink("https://www.google.com/maps/search/91.0,-9.1");
    expect(link?.kind).toBe("google");
    if (link?.kind !== "google") return;
    expect(link.lat).toBeUndefined();
  });

  it("flags a share-sheet short link instead of failing silently", () => {
    // A short link carries nothing until it is followed, and we never fetch.
    expect(parsePastedLink("https://maps.app.goo.gl/aBcDeFgHiJk")).toEqual({ kind: "short-link" });
    expect(parsePastedLink("https://goo.gl/maps/aBcDeFg")).toEqual({ kind: "short-link" });
  });

  it("only counts https Google hosts as Google links", () => {
    expect(parsePastedLink("http://www.google.com/maps/@51.5,-0.12,14z")).toBeUndefined();
    expect(parsePastedLink("http://maps.app.goo.gl/aBcDeFgHiJk")).toBeUndefined();
  });
});

describe("parsePastedLink — OpenStreetMap", () => {
  it("reads a typed element, which is the case worth having", () => {
    expect(parsePastedLink("https://www.openstreetmap.org/node/240109189")).toEqual({
      kind: "osm",
      ref: { type: "node", id: "240109189" },
    });
  });

  it("keeps the element ref even when the URL also carries a map hash", () => {
    const link = parsePastedLink("https://www.openstreetmap.org/way/12345#map=19/38.72/-9.13");
    expect(link).toEqual({ kind: "osm", ref: { type: "way", id: "12345" } });
  });

  it("yields nothing for a bare marker or map-hash link — only elements resolve", () => {
    expect(
      parsePastedLink("https://www.openstreetmap.org/?mlat=51.5074&mlon=-0.1278#map=17/51.5/-0.12"),
    ).toBeUndefined();
    expect(
      parsePastedLink("https://www.openstreetmap.org/#map=17/38.7207/-9.1352"),
    ).toBeUndefined();
  });
});

describe("parsePastedLink — Apple Maps", () => {
  it("reads coordinates and a query name", () => {
    expect(
      parsePastedLink("https://maps.apple.com/?ll=38.7207,-9.1352&q=Cervejaria%20Ramiro"),
    ).toEqual({
      kind: "apple",
      lat: 38.7207,
      lng: -9.1352,
      name: "Cervejaria Ramiro",
      url: "https://maps.apple.com/?ll=38.7207,-9.1352&q=Cervejaria%20Ramiro",
    });
  });

  it("does not take a coordinate pair in q as a name, and falls back to address", () => {
    const pin = parsePastedLink("https://maps.apple.com/?ll=1,2&q=1,2");
    expect(pin?.kind === "apple" && pin.name).toBeUndefined();
    // URLSearchParams decodes `+` as a space, so the address arrives readable.
    const address = parsePastedLink("https://maps.apple.com/?ll=1,2&address=Rua+das+Flores");
    expect(address?.kind === "apple" && address.name).toBe("Rua das Flores");
  });

  it("reads sll when ll is absent, and yields nothing without coordinates", () => {
    const sll = parsePastedLink("https://maps.apple.com/?sll=38.7,-9.1");
    expect(sll?.kind === "apple" && sll.lat).toBe(38.7);
    expect(parsePastedLink("https://maps.apple.com/?q=Ramiro")).toBeUndefined();
  });
});

describe("parsePastedLink — rejection", () => {
  it.each([
    "",
    "not a url",
    "coffee near me",
    "javascript:alert(1)",
    "https://example.com/maps/place/Somewhere",
    "https://not-google.com/maps/@1,2,3z",
  ])("returns undefined for %j", (input) => {
    expect(parsePastedLink(input)).toBeUndefined();
  });

  it("refuses coordinates outside the world", () => {
    expect(parsePastedLink("https://maps.apple.com/?ll=91,0")).toBeUndefined();
  });
});

describe("googleFeatureId", () => {
  it("reads the 0x…:0x… pair and the cid form, case-insensitively", () => {
    expect(
      googleFeatureId("https://www.google.com/maps/place/R/data=!4m2!3m1!1s0x1F9A2B:0xDEADBEEF"),
    ).toBe("0x1f9a2b:0xdeadbeef");
    expect(googleFeatureId("https://maps.google.com/?cid=123456")).toBe("cid:123456");
  });

  it("yields nothing for a plain search URL", () => {
    expect(googleFeatureId("https://www.google.com/maps/search/lisbon")).toBeUndefined();
  });
});

describe("outbound links", () => {
  it("reopens the exact Google listing when one was retained", () => {
    const url = googleLink({
      name: "Ramiro",
      lat: 38.72,
      lng: -9.14,
      googleUrl: "https://www.google.com/maps/place/Ramiro/data=!4m2!3m1!1s0x1f:0x2a",
    });
    expect(url).toContain("/maps/place/Ramiro");
  });

  it("ignores a stored URL that is not an https Google host", () => {
    for (const googleUrl of ["https://evil.example/steal", "http://www.google.com/maps/place/R"]) {
      const url = googleLink({ name: "R", lat: 38.72, lng: -9.14, googleUrl });
      expect(url).toContain("google.com/maps/search");
      expect(url).not.toContain(googleUrl);
    }
  });

  it("searches by name and coordinates when nothing was retained", () => {
    expect(googleLink({ name: "Ramiro", lat: 38.72, lng: -9.14 })).toBe(
      "https://www.google.com/maps/search/?api=1&query=Ramiro%2038.72%2C-9.14",
    );
  });

  it("reuses a retained Apple link, else builds a working one", () => {
    expect(
      appleLink({ name: "R", lat: 1, lng: 2, appleUrl: "https://maps.apple.com/?ll=1,2&q=R" }),
    ).toBe("https://maps.apple.com/?ll=1,2&q=R");
    expect(appleLink({ name: "Ramiro", lat: 38.72, lng: -9.14 })).toBe(
      "https://maps.apple.com/?ll=38.72,-9.14&q=Ramiro",
    );
  });

  it("links the OSM element page when bound, else an mlat/mlon map link — always a string", () => {
    expect(osmLink({ lat: 1, lng: 2, osmRef: { type: "node", id: "7" } })).toBe(
      "https://www.openstreetmap.org/node/7",
    );
    expect(osmLink({ lat: 38.72, lng: -9.14 })).toBe(
      "https://www.openstreetmap.org/?mlat=38.72&mlon=-9.14",
    );
  });
});
