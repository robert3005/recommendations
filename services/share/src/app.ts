/**
 * The share service (book/src/sharing.md §Share service): public reads, Bearer
 * mutations. The client generates the editor token; only its SHA-256 hash is
 * stored; comparison is constant-time; slugs claim atomically; If-Match guards
 * every mutation; idempotency keys make retries safe; revoked slugs tombstone
 * and are never reassigned. Mutation responses are no-store; public GETs carry
 * bounded cache lifetimes and noindex.
 */
import {
  createGuideRequestSchema,
  createNoteRequestSchema,
  LIMITS,
  putGuideRequestSchema,
  putNoteRequestSchema,
  RESERVED_SLUGS,
  sharedGuideSchema,
  sharedNoteSchema,
} from "@placemarks/schemas";
import { Hono } from "hono";
import type { ShareStorage } from "./storage";

export interface ServiceOptions {
  storage: ShareStorage;
  now?: () => string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time hex comparison. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerToken(header: string | undefined): string | undefined {
  // ≥256 random bits: 43 unpadded base64url characters minimum.
  const match = header?.match(/^Bearer\s+(\S{43,512})$/);
  return match?.[1];
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Strict ETag revision: exactly "N" — a malformed value never partially parses. */
function parseIfMatch(value: string | undefined): number | undefined {
  const match = value?.match(/^"(\d+)"$/);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * The media pipeline issues server-side ids bound to a publication and token
 * (book/src/notes.md); until it exists, no document may claim one. Structural:
 * inspects the parsed value, so JSON escape spellings cannot slip through.
 */
function claimsHostedMedia(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(claimsHostedMedia);
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, nested]) => key === "hostedMediaId" || claimsHostedMedia(nested),
    );
  }
  return false;
}

const MUTATION_HEADERS = { "Cache-Control": "no-store" } as const;

const PUBLIC_HEADERS = {
  "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
  "X-Robots-Tag": "noindex",
} as const;

export function createShareApp({ storage, now = () => new Date().toISOString() }: ServiceOptions) {
  const app = new Hono();

  // The web client is hosted separately — every /s/* response (not just the
  // preflight) must carry the CORS grant or the browser discards it.
  app.use("/s/*", async (c, next) => {
    await next();
    const origin = c.req.header("origin");
    if (origin) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      c.res.headers.append("Vary", "Origin");
    }
  });

  // The web client is hosted separately — answer CORS preflight for the
  // mutation headers the protocol requires. Reads are public anyway.
  app.options("/s/*", (c) =>
    c.body(null, 204, {
      "Access-Control-Allow-Origin": c.req.header("origin") ?? "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, if-match",
      "Access-Control-Max-Age": "86400",
    }),
  );

  const schemas = {
    list: { create: createGuideRequestSchema, put: putGuideRequestSchema, doc: sharedGuideSchema },
    note: { create: createNoteRequestSchema, put: putNoteRequestSchema, doc: sharedNoteSchema },
  } as const;

  for (const collection of ["lists", "notes"] as const) {
    const kind = collection === "lists" ? ("list" as const) : ("note" as const);

    app.get(`/s/${collection}/:slug`, async (c) => {
      const slug = c.req.param("slug");
      const reads = await storage.hit(
        `read:${c.req.header("cf-connecting-ip") ?? "local"}`,
        60_000,
        Date.now(),
      );
      if (reads > LIMITS.readsPerMinute) return c.text("rate limited", 429, MUTATION_HEADERS);
      const doc = await storage.get(kind, slug);
      if (!doc || doc.revoked) {
        // A tombstone and a never-existed slug read identically (no probing).
        return c.text("not found", 404, PUBLIC_HEADERS);
      }
      await storage.audit({ at: now(), slug, kind, action: "read", revision: doc.revision });
      const etag = `"${doc.revision}"`;
      // A stable purgeable surrogate key per publication: an update or revoke
      // can purge every cached representation deterministically.
      const surrogate = { "Surrogate-Key": `${kind}/${slug}` } as const;
      if (c.req.header("if-none-match") === etag) {
        return c.body(null, 304, { ...PUBLIC_HEADERS, ...surrogate, ETag: etag });
      }
      return c.body(doc.body, 200, {
        ...PUBLIC_HEADERS,
        ...surrogate,
        ETag: etag,
        "Content-Type": "application/json; charset=utf-8",
      });
    });

    app.post(`/s/${collection}`, async (c) => {
      const token = bearerToken(c.req.header("authorization"));
      if (!token) return c.text("missing editor token", 401, MUTATION_HEADERS);
      const tokenHash = await sha256Hex(token);
      const idKey = c.req.header("idempotency-key");
      if (!idKey) return c.text("missing Idempotency-Key", 400, MUTATION_HEADERS);
      // Abuse quotas apply before any attacker-controlled parsing — malformed
      // attempts are still attempts. Creation quotas bind per token AND per
      // source: rotating tokens is not an escape hatch (book/src/sharing.md).
      const mutations = await storage.hit(`mutate:${tokenHash}`, 60_000, Date.now());
      const sourceCreates = await storage.hit(
        `create-ip:${c.req.header("cf-connecting-ip") ?? "local"}`,
        60_000,
        Date.now(),
      );
      if (mutations > LIMITS.mutationsPerMinute || sourceCreates > LIMITS.mutationsPerMinute) {
        return c.text("rate limited", 429, MUTATION_HEADERS);
      }

      const raw = await c.req.text();
      if (utf8Bytes(raw) > LIMITS.requestBytes)
        return c.text("payload too large", 413, MUTATION_HEADERS);
      let parsed: { desiredSlug: string; document: unknown };
      try {
        const body = schemas[kind].create.safeParse(JSON.parse(raw));
        if (!body.success) return c.text("invalid document", 400, MUTATION_HEADERS);
        parsed = body.data;
      } catch {
        return c.text("invalid JSON", 400, MUTATION_HEADERS);
      }
      const slug = parsed.desiredSlug;
      // Idempotency keys are scoped to (operation, slug, token) — a key can
      // neither complete a different operation, nor replay one slug's result
      // as another's, nor leak another owner's result. A pending reservation
      // (status 0) never replays, and even a stored success replays only when
      // the document it describes actually exists under our token — a record
      // stranded by an interrupted claim re-executes instead.
      const scopedKey = `${kind}:post:${slug}:${tokenHash}:${idKey}`;
      const ownsDocument = async () => {
        const doc = await storage.get(kind, slug);
        return Boolean(doc && !doc.revoked && timingSafeEqualHex(doc.tokenHash, tokenHash));
      };
      const replay = await storage.getIdempotent(scopedKey);
      if (replay && replay.status >= 200 && (await ownsDocument())) {
        return c.body(replay.response, replay.status as 200, {
          ...MUTATION_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
        });
      }
      if (RESERVED_SLUGS.has(slug)) return c.text("reserved slug", 409, MUTATION_HEADERS);
      if (kind === "note") {
        const docSlug = (parsed.document as { slug?: string }).slug;
        if (docSlug !== slug) {
          return c.text("document slug disagrees with the claimed URL", 400, MUTATION_HEADERS);
        }
      }
      if (claimsHostedMedia(parsed.document)) {
        return c.text(
          "hosted media ids must be issued by the media service for this publication",
          422,
          MUTATION_HEADERS,
        );
      }
      const documentBody = JSON.stringify(parsed.document);
      if (utf8Bytes(documentBody) > LIMITS.documentBytes) {
        return c.text("document too large", 413, MUTATION_HEADERS);
      }

      const at = now();
      const collision = async () => {
        // A concurrent identical retry replays the winner's response — but
        // only when the winning claim is really ours; a premature record from
        // a claim another token won never acknowledges ownership.
        const winner = await storage.getIdempotent(scopedKey);
        if (winner && winner.status >= 200 && (await ownsDocument())) {
          return c.body(winner.response, winner.status as 200, {
            ...MUTATION_HEADERS,
            "Content-Type": "application/json; charset=utf-8",
          });
        }
        await storage.audit({ at, slug, kind, action: "denied" });
        return c.text("slug already taken", 409, MUTATION_HEADERS);
      };
      if (await storage.get(kind, slug)) return collision();
      // Everything durable precedes the public claim: audit, then the key
      // reservation, then the replayable result, then the document itself. An
      // interrupted create leaves no public document; because the audit
      // strictly precedes the reservation, a retry that finds the reservation
      // knows the audit already landed and never duplicates it.
      if (!replay) await storage.audit({ at, slug, kind, action: "create", revision: 1 });
      await storage.putIdempotent({ key: scopedKey, response: "", status: 0 });
      const response = JSON.stringify({ slug, revision: 1 });
      await storage.putIdempotent({ key: scopedKey, response, status: 201 });
      const created = await storage.create({
        slug,
        kind,
        revision: 1,
        tokenHash,
        body: documentBody,
        createdAt: at,
        updatedAt: at,
        revoked: false,
      });
      if (!created) return collision();
      return c.body(response, 201, {
        ...MUTATION_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
      });
    });

    const authorized = async (c: {
      req: { header: (name: string) => string | undefined; param: (n: "slug") => string };
    }): Promise<
      | { ok: true; slug: string; token: string; expected: number }
      | { ok: false; status: 401 | 403 | 404 | 412 | 428 }
    > => {
      const token = bearerToken(c.req.header("authorization"));
      if (!token) return { ok: false, status: 401 };
      const slug = c.req.param("slug");
      const doc = await storage.get(kind, slug);
      if (!doc || doc.revoked) return { ok: false, status: 404 };
      if (!timingSafeEqualHex(doc.tokenHash, await sha256Hex(token))) {
        await storage.audit({ at: now(), slug, kind, action: "denied" });
        return { ok: false, status: 403 };
      }
      const match = c.req.header("if-match");
      if (!match) return { ok: false, status: 428 }; // Precondition Required
      const expected = parseIfMatch(match);
      if (expected === undefined || expected !== doc.revision) {
        return { ok: false, status: 412 };
      }
      return { ok: true, slug, token, expected };
    };

    app.put(`/s/${collection}/:slug`, async (c) => {
      const idKey = c.req.header("idempotency-key");
      if (!idKey) return c.text("missing Idempotency-Key", 400, MUTATION_HEADERS);
      // Authorization comes first — an idempotent result never leaks to an
      // unauthenticated or wrong-token retry.
      const auth = await authorized(c);
      if (!auth.ok && auth.status !== 412) {
        return c.text("mutation refused", auth.status, MUTATION_HEADERS);
      }
      const tokenHash = await sha256Hex(bearerToken(c.req.header("authorization")) ?? "");
      // Scoped to (operation, slug, token): a key can neither complete a
      // different operation nor replay one slug's result as another's.
      const scopedKey = `${kind}:put:${c.req.param("slug")}:${tokenHash}:${idKey}`;
      const replay = await storage.getIdempotent(scopedKey);
      // A pending marker (status 0) reserves the key but never replays — an
      // interrupted attempt re-executes instead of faking success.
      if (replay && replay.status >= 200) {
        return c.body(replay.response, replay.status as 200, {
          ...MUTATION_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
        });
      }
      // Malformed authorized updates are still mutation attempts — the abuse
      // quota applies before any attacker-controlled parsing.
      const mutations = await storage.hit(`mutate:${tokenHash}`, 60_000, Date.now());
      if (mutations > LIMITS.mutationsPerMinute) {
        return c.text("rate limited", 429, MUTATION_HEADERS);
      }
      const raw = await c.req.text();
      if (utf8Bytes(raw) > LIMITS.requestBytes)
        return c.text("payload too large", 413, MUTATION_HEADERS);
      let document: unknown;
      try {
        const body = schemas[kind].put.safeParse(JSON.parse(raw));
        if (!body.success) return c.text("invalid document", 400, MUTATION_HEADERS);
        document = body.data.document;
      } catch {
        return c.text("invalid JSON", 400, MUTATION_HEADERS);
      }
      // The published note document must keep naming its public URL.
      if (kind === "note") {
        const docSlug = (document as { slug?: string }).slug;
        if (docSlug !== c.req.param("slug")) {
          return c.text("document slug disagrees with the public URL", 400, MUTATION_HEADERS);
        }
      }
      if (claimsHostedMedia(document)) {
        return c.text(
          "hosted media ids must be issued by the media service for this publication",
          422,
          MUTATION_HEADERS,
        );
      }
      const serialized = JSON.stringify(document);
      if (utf8Bytes(serialized) > LIMITS.documentBytes) {
        return c.text("document too large", 413, MUTATION_HEADERS);
      }
      if (!auth.ok) {
        // A pending reservation plus a document that already matches this
        // exact request means our earlier attempt committed but its success
        // record was lost — recover the result instead of failing the retry.
        if (auth.status === 412 && replay) {
          const expected = parseIfMatch(c.req.header("if-match"));
          const doc = await storage.get(kind, c.req.param("slug"));
          if (
            expected !== undefined &&
            doc &&
            !doc.revoked &&
            timingSafeEqualHex(doc.tokenHash, tokenHash) &&
            doc.revision === expected + 1 &&
            doc.body === serialized
          ) {
            const recovered = JSON.stringify({ slug: doc.slug, revision: doc.revision });
            await storage.putIdempotent({ key: scopedKey, response: recovered, status: 200 });
            return c.body(recovered, 200, {
              ...MUTATION_HEADERS,
              "Content-Type": "application/json; charset=utf-8",
            });
          }
        }
        return c.text("mutation refused", auth.status, MUTATION_HEADERS);
      }
      const at = now();
      // Audit and the key reservation precede the commit: a revision must not
      // exist without either (a failed write aborts with nothing changed). The
      // replayable SUCCESS record lands only after the document write — a
      // failed write must re-execute, never phantom-replay success.
      await storage.audit({
        at,
        slug: auth.slug,
        kind,
        action: "update",
        revision: auth.expected + 1,
      });
      await storage.putIdempotent({ key: scopedKey, response: "", status: 0 });
      const result = await storage.update(kind, auth.slug, auth.expected, serialized, at);
      if (result === "missing" || result === "conflict") {
        const status = result === "missing" ? 404 : 412;
        await storage.putIdempotent({
          key: scopedKey,
          response: result === "missing" ? "not found" : "stale revision",
          status,
        });
        return c.text(result === "missing" ? "not found" : "stale revision", status, {
          ...MUTATION_HEADERS,
        });
      }
      const response = JSON.stringify({ slug: auth.slug, revision: result.revision });
      await storage.putIdempotent({ key: scopedKey, response, status: 200 });
      return c.body(response, 200, {
        ...MUTATION_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
      });
    });

    app.delete(`/s/${collection}/:slug`, async (c) => {
      const idKey = c.req.header("idempotency-key");
      if (!idKey) return c.text("missing Idempotency-Key", 400, MUTATION_HEADERS);
      const token = bearerToken(c.req.header("authorization"));
      if (!token) return c.text("missing editor token", 401, MUTATION_HEADERS);
      const tokenHash = await sha256Hex(token);
      const scopedKey = `${kind}:delete:${c.req.param("slug")}:${tokenHash}:${idKey}`;
      const replay = await storage.getIdempotent(scopedKey);
      // A completed revoke replays as success (status >= 200 records only).
      if (replay && replay.status >= 200) return c.body(null, 204, MUTATION_HEADERS);
      const auth = await authorized(c);
      if (!auth.ok) {
        if (auth.status === 404) {
          // A reservation under our (token, slug, key) scope plus a tombstone
          // under our token means this revocation already applied — by an
          // interrupted earlier attempt or a concurrent retry of the same job.
          // Recover the success instead of reading the tombstone as gone.
          const record = replay ?? (await storage.getIdempotent(scopedKey));
          const doc = await storage.get(kind, c.req.param("slug"));
          if (record && doc?.revoked && timingSafeEqualHex(doc.tokenHash, tokenHash)) {
            await storage.putIdempotent({ key: scopedKey, response: "", status: 204 });
            return c.body(null, 204, MUTATION_HEADERS);
          }
        }
        return c.text("mutation refused", auth.status, MUTATION_HEADERS);
      }
      // Revocation is a mutation like any other — the same per-token quota.
      const mutations = await storage.hit(`mutate:${tokenHash}`, 60_000, Date.now());
      if (mutations > LIMITS.mutationsPerMinute) {
        return c.text("rate limited", 429, MUTATION_HEADERS);
      }
      const at = now();
      await storage.audit({ at, slug: auth.slug, kind, action: "revoke" });
      await storage.putIdempotent({ key: scopedKey, response: "", status: 0 });
      const result = await storage.revoke(kind, auth.slug, auth.expected, at);
      if (result !== "ok") {
        // A concurrent identical retry converges on the winner's success: its
        // record, or the tombstone the winner left under our token (we hold a
        // reservation for exactly this job, so the outcome is ours to claim).
        const winner = await storage.getIdempotent(scopedKey);
        if (winner && winner.status >= 200) return c.body(null, 204, MUTATION_HEADERS);
        const doc = await storage.get(kind, auth.slug);
        if (doc?.revoked && timingSafeEqualHex(doc.tokenHash, tokenHash)) {
          await storage.putIdempotent({ key: scopedKey, response: "", status: 204 });
          return c.body(null, 204, MUTATION_HEADERS);
        }
        if (result === "missing") return c.text("not found", 404, MUTATION_HEADERS);
        return c.text("stale revision", 412, MUTATION_HEADERS);
      }
      await storage.putIdempotent({ key: scopedKey, response: "", status: 204 });
      return c.body(null, 204, MUTATION_HEADERS);
    });
  }

  return app;
}
