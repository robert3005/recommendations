import { describe, expect, it } from "vitest";
import { fromCacheEntry, toCacheEntry } from "./worker";

const gzipTile = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]).buffer;

describe("edge cache entries", () => {
  it("store a gzip tile without Content-Encoding and restore it on a hit, bytes unchanged", async () => {
    const served = new Response(gzipTile, {
      headers: { "Content-Encoding": "gzip", "Content-Type": "application/vnd.mapbox-vector-tile" },
    });
    const entry = toCacheEntry(gzipTile, served);
    expect(entry.headers.get("Content-Encoding")).toBeNull();
    expect(entry.headers.get("X-Stored-Encoding")).toBe("gzip");

    const hit = await fromCacheEntry(entry);
    expect(hit.headers.get("Content-Encoding")).toBe("gzip");
    expect(hit.headers.get("X-Stored-Encoding")).toBeNull();
    expect(hit.headers.get("Content-Type")).toBe("application/vnd.mapbox-vector-tile");
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(new Uint8Array(gzipTile));
  });

  it("leave an unencoded asset unencoded", async () => {
    const body = new TextEncoder().encode("{}").buffer;
    const entry = toCacheEntry(body, new Response(body, { headers: { "Content-Type": "application/json" } }));
    const hit = await fromCacheEntry(entry);
    expect(hit.headers.get("Content-Encoding")).toBeNull();
    expect(await hit.text()).toBe("{}");
  });
});
