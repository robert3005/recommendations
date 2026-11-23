/**
 * The share service (spec/src/sharing.md §The share service): public reads,
 * Bearer mutations, no accounts. PUT is create-or-update — the first PUT claims
 * the slug and binds the token hash (201); the same token replaces the document
 * (200); a foreign token is 403; a tombstoned slug is 410 and is never
 * reassigned. The client generates the editor token; only its SHA-256 hash is
 * stored; comparison is constant-time. GETs carry an ETag (hash of the body)
 * and a short shared-cache lifetime; DELETE tombstones and repeats as 204.
 */
import {
  libraryIdSchema,
  parsePublishedDocument,
  SYNC_LIMITS,
  syncPushSchema,
} from "@placemarks/schemas";
import { bearerToken, sha256Hex, timingSafeEqualHex, utf8Bytes } from "@placemarks/service-kit";
import { Hono } from "hono";
import { type InsightsOptions, mountInsights } from "./insights";
import { type FetchLike, resolveShortLink } from "./resolveLink";
import type { DocumentKind, InsightsCache, ShareStorage, SyncStorage } from "./storage";

export interface ServiceOptions {
  /** Publishing and — when the adapter implements it — sync share one store. */
  storage: ShareStorage & Partial<SyncStorage> & Partial<InsightsCache>;
  /** Hosted review insights; absent, /i/places answers 501. */
  insights?: Omit<InsightsOptions, "storage">;
  now?: () => string;
  /** Best-effort single-URL shared-cache purge after an update or revoke. */
  purge?: (url: string) => Promise<unknown>;
  /** Upstream fetch for short-link expansion; absent, the route answers 501. */
  fetchUpstream?: FetchLike;
}

/** Request/abuse limits. Document-level limits live in @placemarks/schemas. */
export const LIMITS = {
  /** Whole request body cap in bytes. */
  requestBytes: 1_048_576,
  /** Mutations per (token, source) per minute. */
  mutationsPerMinute: 30,
  /** Short-link expansions per source per minute. */
  resolvesPerMinute: 20,
} as const;

/** Public slugs: normalised (domain slugFromTitle), never secrets. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

export const RESERVED_SLUGS = new Set([
  "api",
  "admin",
  "app",
  "assets",
  "help",
  "l",
  "list",
  "lists",
  "login",
  "p",
  "post",
  "posts",
  "review",
  "s",
  "settings",
  "share",
  "static",
  "www",
]);

const MUTATION_HEADERS = { "Cache-Control": "no-store" } as const;

const PUBLIC_HEADERS = {
  "Cache-Control": "public, s-maxage=60",
  "X-Robots-Tag": "noindex",
} as const;

const JSON_TYPE = { "Content-Type": "application/json; charset=utf-8" } as const;

export function createShareApp({
  storage,
  now = () => new Date().toISOString(),
  purge,
  fetchUpstream,
  insights,
}: ServiceOptions) {
  const app = new Hono();

  if (storage.getInsights && storage.putInsights) {
    mountInsights(app, {
      ...insights,
      storage: storage as ShareStorage & InsightsCache,
    });
  }

  // The web client may be hosted separately — every /s response (not just the
  // preflight) must carry the CORS grant or the browser discards it. No
  // cookies are involved, so the wildcard grant is safe for the Bearer header.
  app.use("/s/*", async (c, next) => {
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", "*");
  });

  app.options("/s/*", (c) =>
    c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, if-none-match",
      "Access-Control-Max-Age": "86400",
    }),
  );

  // Short-link expansion (spec/src/interop.md §One place via a link): follows
  // a Google Maps share link's redirect and returns only the URL it points
  // at. Never cached — the answer is one person's paste.
  app.get("/s/resolve-link", async (c) => {
    if (!fetchUpstream) return c.text("not available", 501, MUTATION_HEADERS);
    const source = c.req.header("cf-connecting-ip") ?? "local";
    const hits = await storage.hit(`r:${source}`, 60_000, Date.now());
    if (hits > LIMITS.resolvesPerMinute) return c.text("rate limited", 429, MUTATION_HEADERS);
    const result = await resolveShortLink(c.req.query("url") ?? "", fetchUpstream);
    if (result.ok) return c.json({ url: result.url }, 200, MUTATION_HEADERS);
    if (result.reason === "not-a-short-link") {
      return c.text("not a short link", 400, MUTATION_HEADERS);
    }
    return c.text(
      result.reason === "upstream" ? "upstream unreachable" : "link did not resolve",
      result.reason === "upstream" ? 502 : 422,
      MUTATION_HEADERS,
    );
  });

  for (const collection of ["lists", "posts"] as const) {
    const kind: DocumentKind = collection === "lists" ? "list" : "post";

    app.get(`/s/${collection}/:slug`, async (c) => {
      const doc = await storage.get(kind, c.req.param("slug"));
      if (!doc) return c.text("not found", 404, PUBLIC_HEADERS);
      if (doc.revokedAt !== null) return c.text("gone", 410, PUBLIC_HEADERS);
      const etag = `"${await sha256Hex(doc.body)}"`;
      if (c.req.header("if-none-match") === etag) {
        return c.body(null, 304, { ...PUBLIC_HEADERS, ETag: etag });
      }
      return c.body(doc.body, 200, { ...PUBLIC_HEADERS, ...JSON_TYPE, ETag: etag });
    });

    app.put(`/s/${collection}/:slug`, async (c) => {
      const token = bearerToken(c.req.header("authorization"));
      if (!token) return c.text("missing editor token", 401, MUTATION_HEADERS);
      const slug = c.req.param("slug");
      if (!SLUG_PATTERN.test(slug)) return c.text("invalid slug", 400, MUTATION_HEADERS);
      if (RESERVED_SLUGS.has(slug)) return c.text("reserved slug", 400, MUTATION_HEADERS);
      const tokenHash = await sha256Hex(token);
      // The abuse quota applies before any attacker-controlled parsing —
      // malformed attempts are still attempts. One bucket per (token, source).
      const source = c.req.header("cf-connecting-ip") ?? "local";
      const hits = await storage.hit(`m:${tokenHash}:${source}`, 60_000, Date.now());
      if (hits > LIMITS.mutationsPerMinute) return c.text("rate limited", 429, MUTATION_HEADERS);

      const raw = await c.req.text();
      if (utf8Bytes(raw) > LIMITS.requestBytes) {
        return c.text("payload too large", 413, MUTATION_HEADERS);
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return c.text("invalid JSON", 400, MUTATION_HEADERS);
      }
      try {
        parsePublishedDocument(kind, json);
      } catch {
        return c.text("invalid document", 400, MUTATION_HEADERS);
      }
      const body = JSON.stringify(json);

      const at = now();
      const response = JSON.stringify({ slug });
      const existing = await storage.get(kind, slug);
      if (!existing) {
        // The claim is one atomic INSERT; a lost race falls through to the
        // ownership logic against whatever the winner wrote.
        const claim = { kind, slug, tokenHash, body, revokedAt: null, updatedAt: at };
        if (await storage.create(claim)) {
          await purge?.(c.req.url).catch(() => undefined);
          return c.body(response, 201, { ...MUTATION_HEADERS, ...JSON_TYPE });
        }
      }
      const current = existing ?? (await storage.get(kind, slug));
      if (!current) return c.text("conflict", 409, MUTATION_HEADERS);
      if (current.revokedAt !== null) return c.text("gone", 410, MUTATION_HEADERS);
      if (!timingSafeEqualHex(current.tokenHash, tokenHash)) {
        return c.text("forbidden", 403, MUTATION_HEADERS);
      }
      if (!(await storage.update(kind, slug, body, at))) {
        // The only live→dead transition is the owner's own concurrent revoke.
        return c.text("gone", 410, MUTATION_HEADERS);
      }
      await purge?.(c.req.url).catch(() => undefined);
      return c.body(response, 200, { ...MUTATION_HEADERS, ...JSON_TYPE });
    });

    app.delete(`/s/${collection}/:slug`, async (c) => {
      const token = bearerToken(c.req.header("authorization"));
      if (!token) return c.text("missing editor token", 401, MUTATION_HEADERS);
      const tokenHash = await sha256Hex(token);
      const source = c.req.header("cf-connecting-ip") ?? "local";
      const hits = await storage.hit(`m:${tokenHash}:${source}`, 60_000, Date.now());
      if (hits > LIMITS.mutationsPerMinute) return c.text("rate limited", 429, MUTATION_HEADERS);
      const slug = c.req.param("slug");
      const doc = await storage.get(kind, slug);
      if (!doc) return c.text("not found", 404, MUTATION_HEADERS);
      if (!timingSafeEqualHex(doc.tokenHash, tokenHash)) {
        return c.text("forbidden", 403, MUTATION_HEADERS);
      }
      // Idempotent by nature: revoking a tombstone changes nothing and is 204.
      await storage.revoke(kind, slug, now());
      await purge?.(c.req.url).catch(() => undefined);
      return c.body(null, 204, MUTATION_HEADERS);
    });
  }

  mountSync(app, storage, now);
  return app;
}

/**
 * Sync (spec/src/sync.md §The service): `/y/:library` holds a library's
 * encrypted rows. Like a published slug, a library is claimed by its first
 * authorised request and afterwards answers only to the same token; unlike a
 * slug, nothing here is public — every route needs the Bearer token, and the
 * rows are ciphertext the service cannot read.
 *
 *   PUT    /y/:library          claim (201) or confirm (200); 403 for a foreign token
 *   POST   /y/:library/rows     upsert rows, each under the next sequence number
 *   GET    /y/:library/changes  rows after ?since=N, ascending, paged
 *   DELETE /y/:library          remove the library and its rows (204, repeatable)
 */
function mountSync(app: Hono, storage: ServiceOptions["storage"], now: () => string): void {
  const sync = storage as ShareStorage & SyncStorage;
  const supported = typeof storage.getLibrary === "function";

  app.use("/y/*", async (c, next) => {
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", "*");
    c.res.headers.set("Cache-Control", "no-store");
  });

  app.options("/y/*", (c) =>
    c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Max-Age": "86400",
    }),
  );

  /**
   * Everything every sync route does first: shape, token, quota, ownership.
   * Returns the library id and token hash, or the response that ends the request.
   */
  async function authorise(
    c: {
      req: { param(name: string): string; header(name: string): string | undefined };
      text(body: string, status: 400 | 401 | 403 | 404 | 429 | 501): Response;
    },
    opts: { claim: boolean },
  ): Promise<{ id: string; tokenHash: string; created: boolean } | Response> {
    if (!supported) return c.text("sync is not available on this service", 501);
    const id = c.req.param("library");
    if (!libraryIdSchema.safeParse(id).success) return c.text("invalid library", 400);
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return c.text("missing sync token", 401);
    const tokenHash = await sha256Hex(token);
    const source = c.req.header("cf-connecting-ip") ?? "local";
    const hits = await storage.hit(`y:${id}:${source}`, 60_000, Date.now());
    if (hits > SYNC_LIMITS.requestsPerMinute) return c.text("rate limited", 429);

    let library = await sync.getLibrary(id);
    let created = false;
    if (!library) {
      if (!opts.claim) return c.text("no such library", 404);
      // The claim is one atomic INSERT; a lost race falls through to the
      // ownership check against whatever the winner wrote.
      created = await sync.createLibrary({ id, tokenHash, createdAt: now() });
      library = await sync.getLibrary(id);
      if (!library) return c.text("no such library", 404);
    }
    if (!timingSafeEqualHex(library.tokenHash, tokenHash)) return c.text("forbidden", 403);
    return { id, tokenHash, created };
  }

  app.put("/y/:library", async (c) => {
    const auth = await authorise(c, { claim: true });
    if (auth instanceof Response) return auth;
    return c.json({ library: auth.id }, auth.created ? 201 : 200);
  });

  app.post("/y/:library/rows", async (c) => {
    const auth = await authorise(c, { claim: false });
    if (auth instanceof Response) return auth;
    const raw = await c.req.text();
    if (utf8Bytes(raw) > SYNC_LIMITS.requestBytes) return c.text("payload too large", 413);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.text("invalid JSON", 400);
    }
    const parsed = syncPushSchema.safeParse(json);
    if (!parsed.success) return c.text("invalid rows", 400);
    // A generous ceiling, checked before the write: an update of existing rows
    // may be refused a little early at the very limit, never let through late.
    const held = await sync.countRows(auth.id);
    if (held + parsed.data.rows.length > SYNC_LIMITS.rowsPerLibrary) {
      return c.text("library is full", 413);
    }
    const cursor = await sync.putRows(auth.id, parsed.data.rows);
    return c.json({ cursor });
  });

  app.get("/y/:library/changes", async (c) => {
    const auth = await authorise(c, { claim: false });
    if (auth instanceof Response) return auth;
    const sinceRaw = c.req.query("since") ?? "0";
    if (!/^\d{1,15}$/.test(sinceRaw)) return c.text("invalid cursor", 400);
    const since = Number.parseInt(sinceRaw, 10);
    // One extra row answers "is there more?" without a second query.
    const rows = await sync.changesSince(auth.id, since, SYNC_LIMITS.rowsPerPull + 1);
    const page = rows.slice(0, SYNC_LIMITS.rowsPerPull);
    return c.json({
      rows: page,
      cursor: page.length > 0 ? (page[page.length - 1]?.seq ?? since) : since,
      more: rows.length > page.length,
    });
  });

  app.delete("/y/:library", async (c) => {
    const auth = await authorise(c, { claim: false });
    // Deleting what is already gone is the same outcome: repeatable.
    if (auth instanceof Response) return auth.status === 404 ? c.body(null, 204) : auth;
    await sync.deleteLibrary(auth.id);
    return c.body(null, 204);
  });
}
