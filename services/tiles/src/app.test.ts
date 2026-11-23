import { describe, expect, it, vi } from "vitest";
import {
  handleTileRequest,
  TILE_CACHE_CONTROL,
  type TileServiceDeps,
  UnknownArchiveError,
} from "./app";

const tileBytes = new Uint8Array([0x1f, 0x8b, 1, 2, 3]).buffer;

function deps(overrides: Partial<TileServiceDeps> = {}): TileServiceDeps {
  return {
    getTile: vi.fn(async () => ({ data: tileBytes, contentEncoding: "gzip" as const })),
    getAsset: vi.fn(async () => ({ body: new TextEncoder().encode("{}").buffer, etag: '"e1"' })),
    ...overrides,
  };
}

const get = (path: string, method = "GET") =>
  new Request(`https://tiles.example${path}`, { method });

describe("tile service", () => {
  it("serves one stored tile per URL, gzip as stored, cacheable and CORS-open", async () => {
    const d = deps();
    const res = await handleTileRequest(get("/europe/14/7800/6100.mvt"), d);
    expect(res.status).toBe(200);
    expect(d.getTile).toHaveBeenCalledWith("europe", 14, 7800, 6100);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Content-Type")).toBe("application/vnd.mapbox-vector-tile");
    expect(res.headers.get("Cache-Control")).toBe(TILE_CACHE_CONTROL);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(tileBytes));
  });

  it("answers a tile the archive lacks with a cacheable 204, which MapLibre draws empty", async () => {
    const res = await handleTileRequest(
      get("/europe/3/0/0.mvt"),
      deps({ getTile: async () => null }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Cache-Control")).toBe(TILE_CACHE_CONTROL);
  });

  it("rejects coordinates outside the zoom level without touching the archive", async () => {
    const d = deps();
    const res = await handleTileRequest(get("/europe/2/4/0.mvt"), d);
    expect(res.status).toBe(400);
    expect(d.getTile).not.toHaveBeenCalled();
  });

  it("404s an archive that is not in the bucket", async () => {
    const res = await handleTileRequest(
      get("/nowhere/0/0/0.mvt"),
      deps({
        getTile: async () => {
          throw new UnknownArchiveError("nowhere.pmtiles");
        },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("answers a failed archive read with an uncached, CORS-open 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleTileRequest(
      get("/europe/14/8320/6082.mvt"),
      deps({
        getTile: async () => {
          throw new Error("This promise was created by a request that has since ended");
        },
      }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("passes glyphs and sprites through with long cache lifetimes", async () => {
    const d = deps();
    const res = await handleTileRequest(get("/fonts/Noto%20Sans%20Regular/0-255.pbf"), d);
    expect(res.status).toBe(200);
    expect(d.getAsset).toHaveBeenCalledWith("fonts/Noto Sans Regular/0-255.pbf");
    expect(res.headers.get("Content-Type")).toBe("application/x-protobuf");
    expect(res.headers.get("Cache-Control")).toBe(TILE_CACHE_CONTROL);
    expect(res.headers.get("ETag")).toBe('"e1"');
  });

  it("serves only tiles, fonts and sprites from the bucket", async () => {
    const d = deps();
    for (const path of ["/europe.pmtiles", "/secret.txt", "/fonts/../europe.pmtiles", "/"]) {
      const res = await handleTileRequest(get(path), d);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
    }
    expect(d.getAsset).not.toHaveBeenCalled();
  });

  it("answers preflight and HEAD, and refuses writes", async () => {
    expect((await handleTileRequest(get("/europe/0/0/0.mvt", "OPTIONS"), deps())).status).toBe(204);
    const head = await handleTileRequest(get("/europe/0/0/0.mvt", "HEAD"), deps());
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await handleTileRequest(get("/europe/0/0/0.mvt", "POST"), deps())).status).toBe(405);
  });
});
