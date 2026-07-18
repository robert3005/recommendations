/**
 * The starting camera (book/src/map-view.md): stored last viewport wins; else
 * the timezone-derived approximation — city zone, continent fallback, world
 * default. Corrupt storage is ignored, never fatal.
 */
import { describe, expect, it } from "vitest";
import { initialViewport, persistViewport, viewportFromTimezone } from "./viewport";

function memoryStorage(seed?: Record<string, string>) {
  const map = new Map(Object.entries(seed ?? {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

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

  it("a stored last viewport wins over the timezone", () => {
    const storage = memoryStorage();
    persistViewport({ lng: 2.35, lat: 48.86, zoom: 13.5 }, storage);
    expect(initialViewport(storage, "Asia/Tokyo")).toEqual({ lng: 2.35, lat: 48.86, zoom: 13.5 });
  });

  it("corrupt or out-of-range stored viewports are ignored", () => {
    const garbage = memoryStorage({ "placemarks:viewport": "not json" });
    expect(initialViewport(garbage, "Asia/Tokyo").lng).toBe(139.69);
    const outOfRange = memoryStorage({
      "placemarks:viewport": JSON.stringify({ lng: 500, lat: 12, zoom: 9 }),
    });
    expect(initialViewport(outOfRange, "Asia/Tokyo").lng).toBe(139.69);
  });
});
