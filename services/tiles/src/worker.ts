/** Cloudflare Workers entry: PMTiles archives in R2, served one tile per URL. */
import {
  Compression,
  EtagMismatch,
  PMTiles,
  type RangeResponse,
  SharedPromiseCache,
  type Source,
} from "pmtiles";
import { type AssetResult, handleTileRequest, type TileResult, UnknownArchiveError } from "./app";

/** The slice of the R2 binding this worker uses, typed structurally (no workers-types). */
interface R2ObjectBodyLike {
  etag: string;
  httpEtag: string;
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  httpMetadata?: { contentType?: string };
}
interface R2BucketLike {
  get(
    key: string,
    options?: { range?: { offset: number; length: number }; onlyIf?: { etagMatches?: string } },
  ): Promise<R2ObjectBodyLike | { etag: string } | null>;
}

interface Env {
  TILES_BUCKET: R2BucketLike;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** Workers' default edge cache, typed structurally. */
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

class R2Source implements Source {
  constructor(
    private readonly bucket: R2BucketLike,
    private readonly key: string,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(
    offset: number,
    length: number,
    _signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    const object = await this.bucket.get(this.key, {
      range: { offset, length },
      ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
    });
    if (!object) throw new UnknownArchiveError(this.key);
    if (!("arrayBuffer" in object)) {
      // The archive was replaced mid-flight: pmtiles refetches the header.
      throw new EtagMismatch(`ETag mismatch for ${this.key}`);
    }
    return { data: await object.arrayBuffer(), etag: object.etag };
  }
}

async function gunzip(buf: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) return buf;
  if (compression !== Compression.Gzip) throw new Error(`Unsupported compression ${compression}`);
  const stream = new Response(buf).body?.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Leave tiles as stored: they go out with Content-Encoding instead of being re-inflated. */
async function asStored(buf: ArrayBuffer): Promise<ArrayBuffer> {
  return buf;
}

// Headers and directories survive across requests in a warm isolate.
const directoryCache = new SharedPromiseCache(400, true, gunzip);
const archives = new Map<string, PMTiles>();

function archiveOf(bucket: R2BucketLike, name: string): PMTiles {
  let archive = archives.get(name);
  if (!archive) {
    archive = new PMTiles(new R2Source(bucket, `${name}.pmtiles`), directoryCache, asStored);
    archives.set(name, archive);
  }
  return archive;
}

function deps(env: Env) {
  return {
    async getTile(name: string, z: number, x: number, y: number): Promise<TileResult | null> {
      const archive = archiveOf(env.TILES_BUCKET, name);
      const header = await archive.getHeader();
      const tile = await archive.getZxy(z, x, y);
      if (!tile) return null;
      return header.tileCompression === Compression.Gzip
        ? { data: tile.data, contentEncoding: "gzip" }
        : { data: tile.data };
    },
    async getAsset(key: string): Promise<AssetResult | null> {
      const object = await env.TILES_BUCKET.get(key);
      if (!object || !("body" in object)) return null;
      return {
        body: object.body,
        ...(object.httpMetadata?.contentType
          ? { contentType: object.httpMetadata.contentType }
          : {}),
        etag: object.httpEtag,
      };
    },
  };
}

/** A body that is already gzip must go out as-is, not be compressed again. */
function sendEncodedAsIs(response: Response): Response {
  if (!response.headers.has("Content-Encoding")) return response;
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
    encodeBody: "manual",
  } as ResponseInit);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const edge = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;
    const cacheable = request.method === "GET" && edge !== undefined;
    if (cacheable) {
      const hit = await edge.match(request);
      if (hit) return hit;
    }
    const response = sendEncodedAsIs(await handleTileRequest(request, deps(env)));
    if (cacheable && response.status === 200) ctx.waitUntil(edge.put(request, response.clone()));
    return response;
  },
};
