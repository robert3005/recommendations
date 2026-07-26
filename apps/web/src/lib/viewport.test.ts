import { describe, expect, it } from "vitest";
import { viewportFromTimezone } from "./viewport";

describe("starting viewport", () => {
  it("derives a city view from a known timezone", () => {
    expect(viewportFromTimezone("Asia/Tokyo")).toEqual({ lng: 139.69, lat: 35.69, zoom: 10 });
    expect(viewportFromTimezone("Europe/Lisbon")).toEqual({ lng: -9.14, lat: 38.72, zoom: 10 });
  });

  it("falls back to a continent view, then the world", () => {
    expect(viewportFromTimezone("Europe/Unknown_City").zoom).toBe(4);
    expect(viewportFromTimezone("Etc/UTC").zoom).toBeLessThan(2);
    expect(viewportFromTimezone(undefined).zoom).toBeLessThan(2);
  });
});
