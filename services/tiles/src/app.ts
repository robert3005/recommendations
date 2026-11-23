/**
 * The tile service's request handling, free of Workers bindings so it can be
 * tested with plain stubs (spec/src/data-sources.md §Map tiles).
 *
 * - `GET /<archive>/<z>/<x>/<y>.mvt` — one vector tile from `<archive>.pmtiles`.
 *   A tile the archive does not hold is `204 No Content`, which MapLibre draws
 *   as empty. Tiles stay gzip-compressed as stored and are sent with
 *   `Content-Encoding: gzip`.
 * - `GET /fonts/…`, `GET /sprites/…` — the plate's glyphs and sprite, passed
 *   through from the bucket.
 *
 * Everything is public, read-only map data: CORS is open, and responses carry
 * long cache lifetimes so browsers and Cloudflare's edge reuse them.
 */

export interface TileResult {
  data: ArrayBuffer;
  /** "gzip" when the bytes are stored compressed and must be sent with that encoding. */
  contentEncoding?: "gzip";
}

export interface AssetResult {
  body: ArrayBuffer | ReadableStream;
  contentType?: string;
  etag?: string;
}

export class UnknownArchiveError extends Error {}

export interface TileServiceDeps {
  /** The tile, `null` when the archive has no tile there; throws UnknownArchiveError. */
  getTile(archive: string, z: number, x: number, y: number): Promise<TileResult | null>;
  /** A bucket object by key, `null` when missing. */
  getAsset(key: string): Promise<AssetResult | null>;
}

/** Tiles only change when an archive is replaced; a week in browsers, a month at the edge. */
export const TILE_CACHE_CONTROL =
  "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400";
/** Glyph ranges and sprites are as stable as the tiles. */
export const ASSET_CACHE_CONTROL = TILE_CACHE_CONTROL;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const TILE_PATH = /^\/([a-z0-9][a-z0-9-]{0,62})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.mvt$/;
const ASSET_PATH = /^\/(fonts|sprites)\/[^?#]+$/;

const ASSET_TYPES: Record<string, string> = {
  ".pbf": "application/x-protobuf",
  ".json": "application/json",
  ".png": "image/png",
};

function plain(status: number, text?: string, extra: Record<string, string> = {}): Response {
  return new Response(text ?? null, {
    status,
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", ...extra },
  });
}

function assetType(key: string): string {
  const dot = key.lastIndexOf(".");
  return (dot >= 0 && ASSET_TYPES[key.slice(dot)]) || "application/octet-stream";
}

export async function handleTileRequest(
  request: Request,
  deps: TileServiceDeps,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method Not Allowed", { Allow: "GET, HEAD, OPTIONS" });
  }
  const head = request.method === "HEAD";
  const path = new URL(request.url).pathname;

  const tile = TILE_PATH.exec(path);
  if (tile) {
    const [, archive = "", zs = "", xs = "", ys = ""] = tile;
    const z = Number(zs);
    const x = Number(xs);
    const y = Number(ys);
    const side = 2 ** z;
    if (z > 26 || x >= side || y >= side) return plain(400, "Tile outside the zoom level");
    let result: TileResult | null;
    try {
      result = await deps.getTile(archive, z, x, y);
    } catch (error) {
      if (error instanceof UnknownArchiveError) return plain(404, "Unknown archive");
      throw error;
    }
    if (!result) {
      return new Response(null, {
        status: 204,
        headers: { ...CORS, "Cache-Control": TILE_CACHE_CONTROL },
      });
    }
    const headers: Record<string, string> = {
      ...CORS,
      "Content-Type": "application/vnd.mapbox-vector-tile",
      "Cache-Control": TILE_CACHE_CONTROL,
      "Content-Length": String(result.data.byteLength),
    };
    if (result.contentEncoding) headers["Content-Encoding"] = result.contentEncoding;
    return new Response(head ? null : result.data, { status: 200, headers });
  }

  if (ASSET_PATH.test(path)) {
    let key: string;
    try {
      key = decodeURIComponent(path.slice(1));
    } catch {
      return plain(400, "Bad path");
    }
    if (key.split("/").some((part) => part === ".." || part === "")) return plain(400, "Bad path");
    const asset = await deps.getAsset(key);
    if (!asset) return plain(404, "Not Found");
    const headers: Record<string, string> = {
      ...CORS,
      "Content-Type": asset.contentType ?? assetType(key),
      "Cache-Control": ASSET_CACHE_CONTROL,
    };
    if (asset.etag) headers.ETag = asset.etag;
    return new Response(head ? null : asset.body, { status: 200, headers });
  }

  return plain(404, "Not Found");
}
