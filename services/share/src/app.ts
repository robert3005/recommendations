/**
 * The share service (spec/src/sharing.md §The share service): public reads,
 * Bearer mutations, no accounts. PUT is create-or-update — the first PUT claims
 * the slug and binds the token hash (201); the same token replaces the document
 * (200); a foreign token is 403; a tombstoned slug is 410 and is never
 * reassigned. The client generates the editor token; only its SHA-256 hash is
 * stored; comparison is constant-time. GETs carry an ETag (hash of the body)
 * and a short shared-cache lifetime; DELETE tombstones and repeats as 204.
 */
import { parsePublishedDocument } from "@placemarks/schemas";
import { bearerToken, sha256Hex, timingSafeEqualHex, utf8Bytes } from "@placemarks/service-kit";
import { Hono } from "hono";
import type { DocumentKind, ShareStorage } from "./storage";

export interface ServiceOptions {
  storage: ShareStorage;
  now?: () => string;
  /** Best-effort single-URL shared-cache purge after an update or revoke. */
  purge?: (url: string) => Promise<unknown>;
}

/** Request/abuse limits. Document-level limits live in @placemarks/schemas. */
export const LIMITS = {
  /** Whole request body cap in bytes. */
  requestBytes: 1_048_576,
  /** Mutations per (token, source) per minute. */
  mutationsPerMinute: 30,
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
}: ServiceOptions) {
  const app = new Hono();

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

  return app;
}
