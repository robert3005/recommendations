/** Cloudflare Workers entry: PMTiles archives in R2, served one tile per URL. */
import {
  Compression,
  EtagMismatch,
  PMTiles,
  type RangeResponse,
  ResolvedValueCache,
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

// Headers and directories survive across requests in a warm isolate. Only
// settled values are shared: a Workers promise belongs to the request that
// created it, so a ResolvedValueCache made concurrent cold tiles throw
// ("a request that has since ended") whenever the first request finished early.
const directoryCache = new ResolvedValueCache(400, true, gunzip);
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

/**
 * Edge-cache entries hold the stored bytes with no Content-Encoding: the
 * Cache API compressed an already-gzip body a second time on the way back
 * out, so browsers got gzip inside gzip and MapLibre could not parse it.
 * The encoding rides in its own header and is restored on a hit. The key
 * carries a version so entries from the earlier layout are never read.
 */
const STORED_ENCODING = "X-Stored-Encoding";
const CACHE_LAYOUT = "2";

function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.set("_layout", CACHE_LAYOUT);
  return new Request(url.toString(), { method: "GET" });
}

export function toCacheEntry(data: ArrayBuffer, response: Response): Response {
  const headers = new Headers(response.headers);
  const encoding = headers.get("Content-Encoding");
  headers.delete("Content-Encoding");
  if (encoding) headers.set(STORED_ENCODING, encoding);
  return new Response(data, { status: response.status, headers });
}

export async function fromCacheEntry(hit: Response): Promise<Response> {
  const data = await hit.arrayBuffer();
  const headers = new Headers(hit.headers);
  const encoding = headers.get(STORED_ENCODING);
  headers.delete(STORED_ENCODING);
  if (!encoding) return new Response(data, { status: hit.status, headers });
  headers.set("Content-Encoding", encoding);
  return sendEncodedAsIs(new Response(data, { status: hit.status, headers }));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const edge = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;
    const cacheable = request.method === "GET" && edge !== undefined;
    const key = cacheable ? cacheKey(request) : request;
    if (cacheable) {
      const hit = await edge.match(key);
      if (hit) return fromCacheEntry(hit);
    }
    const fresh = await handleTileRequest(request, deps(env));
    if (!cacheable || fresh.status !== 200) return sendEncodedAsIs(fresh);
    const data = await fresh.arrayBuffer();
    ctx.waitUntil(edge.put(key, toCacheEntry(data, fresh)));
    return sendEncodedAsIs(new Response(data, { status: fresh.status, headers: fresh.headers }));
  },
};
