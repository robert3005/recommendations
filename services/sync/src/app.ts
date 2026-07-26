/**
 * The sync service (spec/src/storage-sync.md §Multi-device sync,
 * spec/src/tech-stack.md §Sync backend): a minimal account names the sync
 * scope (email link), push is idempotent by mutation id, pull uses a
 * server-monotonic cursor. It moves private owned entities between the
 * owner's devices — it is NOT the share service, and public links do not
 * depend on it. Token hygiene mirrors the share service: the server stores
 * only a SHA-256 hash and compares in constant time.
 */
import {
  loginCompleteRequestSchema,
  loginRequestSchema,
  pushEnvelopeRequestSchema,
  SYNC_LIMITS,
} from "@placemarks/schemas";
import { bearerToken, sha256Hex, timingSafeEqualHex } from "@placemarks/service-kit";
import { type Context, Hono } from "hono";
import type { SyncStorage } from "./storage";

/** Delivers login codes — email in deployment, a recorder in tests/dev. */
export interface Mailer {
  send(email: string, code: string): Promise<void>;
}

export interface SyncServiceOptions {
  storage: SyncStorage;
  mailer: Mailer;
  now?: () => string;
  /** Random sources injectable for tests. */
  newId?: () => string;
  newCode?: () => string;
  newToken?: () => string;
}

function defaultToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function defaultCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return ((bytes[0] ?? 0) % 1_000_000).toString().padStart(6, "0");
}

const NO_STORE = { "Cache-Control": "no-store" } as const;
const CODE_TTL_MS = 15 * 60_000;
const utf8 = new TextEncoder();

type BoundedJson = { ok: true; value: unknown } | { ok: false; status: 400 | 413; message: string };

/** Stream and count request bytes before retaining/parsing attacker input. */
async function readBoundedJson(c: Context, maxBytes: number): Promise<BoundedJson> {
  const contentLength = c.req.header("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    return { ok: false, status: 413, message: "request too large" };
  }
  const stream = c.req.raw.body;
  if (!stream) return { ok: false, status: 400, message: "invalid request" };
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, message: "request too large" };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, message: "invalid request" };
  }
}

function wireChange(change: Awaited<ReturnType<SyncStorage["changesSince"]>>[number]) {
  return {
    seq: change.seq,
    table: change.table,
    entityId: change.entityId,
    hlc: change.hlc,
    actorId: change.actorId,
    version: change.version,
    row: change.row,
  };
}

export function createSyncApp({
  storage,
  mailer,
  now = () => new Date().toISOString(),
  newId = () => crypto.randomUUID(),
  newCode = defaultCode,
  newToken = defaultToken,
}: SyncServiceOptions) {
  const app = new Hono();

  // The web client is hosted separately — every response carries the grant.
  app.use("/sync/*", async (c, next) => {
    await next();
    const origin = c.req.header("origin");
    if (origin) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      c.res.headers.append("Vary", "Origin");
    }
  });
  app.options("/sync/*", (c) =>
    c.body(null, 204, {
      "Access-Control-Allow-Origin": c.req.header("origin") ?? "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Max-Age": "86400",
    }),
  );

  const account = async (header: string | undefined) => {
    const token = bearerToken(header);
    if (!token) return undefined;
    const hash = await sha256Hex(token);
    return storage.findAccountByTokenHash(hash);
  };

  // Step 1: request a login code — sent to the address, never returned.
  app.post("/sync/login", async (c) => {
    const hits = await storage.hit("login", 60_000, Date.now());
    if (hits > 20) return c.text("rate limited", 429, NO_STORE);
    const body = await readBoundedJson(c, SYNC_LIMITS.loginRequestBytes);
    if (!body.ok) return c.text(body.message, body.status, NO_STORE);
    const parsed = loginRequestSchema.safeParse(body.value);
    if (!parsed.success) return c.text("invalid request", 400, NO_STORE);
    const email = parsed.data.email.toLowerCase();
    const code = newCode();
    await storage.putLoginCode({
      email,
      codeHash: await sha256Hex(code),
      expiresAt: new Date(Date.parse(now()) + CODE_TTL_MS).toISOString(),
    });
    await mailer.send(email, code);
    return c.body(null, 204, NO_STORE);
  });

  // Step 2: complete the login — mints the bearer that names the sync scope.
  app.post("/sync/login/complete", async (c) => {
    const body = await readBoundedJson(c, SYNC_LIMITS.loginRequestBytes);
    if (!body.ok) return c.text(body.message, body.status, NO_STORE);
    const parsed = loginCompleteRequestSchema.safeParse(body.value);
    if (!parsed.success) return c.text("invalid request", 400, NO_STORE);
    const email = parsed.data.email.toLowerCase();
    // Single-use: taking removes it — a failed guess burns the code.
    const pending = await storage.takeLoginCode(email);
    if (!pending || pending.expiresAt < now()) return c.text("invalid code", 401, NO_STORE);
    const codeHash = await sha256Hex(parsed.data.code);
    if (!timingSafeEqualHex(pending.codeHash, codeHash)) {
      return c.text("invalid code", 401, NO_STORE);
    }
    const token = newToken();
    const tokenHash = await sha256Hex(token);
    let existing = await storage.findAccountByEmail(email);
    if (!existing) {
      existing = { id: newId(), email, createdAt: now() };
      await storage.createAccount(existing);
    }
    // Every completed login mints a DEVICE token — several devices sync one
    // scope concurrently (that is the point of Phase 8).
    await storage.addAccountToken(existing.id, tokenHash);
    return c.json({ accountId: existing.id, token }, 200, NO_STORE);
  });

  // Sign out this device only. Other device bearers for the same account stay
  // valid so one browser cannot accidentally disconnect all peers.
  app.post("/sync/logout", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return c.text("unauthorized", 401, NO_STORE);
    const tokenHash = await sha256Hex(token);
    if (!(await storage.findAccountByTokenHash(tokenHash))) {
      return c.text("unauthorized", 401, NO_STORE);
    }
    await storage.removeAccountToken(tokenHash);
    return c.body(null, 204, NO_STORE);
  });

  // A newly email-authenticated device can invalidate a lost/copied bearer
  // without disrupting its own session.
  app.post("/sync/logout/others", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return c.text("unauthorized", 401, NO_STORE);
    const tokenHash = await sha256Hex(token);
    const authed = await storage.findAccountByTokenHash(tokenHash);
    if (!authed) return c.text("unauthorized", 401, NO_STORE);
    await storage.removeOtherAccountTokens(authed.id, tokenHash);
    return c.body(null, 204, NO_STORE);
  });

  // Idempotent push: a re-sent mutation id acks without re-appending.
  app.post("/sync/push", async (c) => {
    const authed = await account(c.req.header("authorization"));
    if (!authed) return c.text("unauthorized", 401, NO_STORE);
    const body = await readBoundedJson(c, SYNC_LIMITS.requestBytes);
    if (!body.ok) return c.text(body.message, body.status, NO_STORE);
    const parsed = pushEnvelopeRequestSchema.safeParse(body.value);
    if (!parsed.success) return c.text("invalid request", 400, NO_STORE);
    const acked: string[] = [];
    for (const mutation of parsed.data.mutations) {
      // Storage owns the atomic idempotency check + sequence allocation. A
      // separate has-then-insert race can collide under concurrent requests.
      await storage.appendChange({
        accountId: authed.id,
        mutationId: mutation.id,
        actorId: mutation.actorId,
        table: mutation.table,
        entityId: mutation.entityId,
        hlc: mutation.hlc,
        version: mutation.version ?? {},
        row: mutation.row,
        recordedAt: now(),
      });
      acked.push(mutation.id);
    }
    return c.json({ acked }, 200, NO_STORE);
  });

  // Server-monotonic cursor pull.
  app.get("/sync/pull", async (c) => {
    const authed = await account(c.req.header("authorization"));
    if (!authed) return c.text("unauthorized", 401, NO_STORE);
    const rawCursor = c.req.query("cursor");
    const after = rawCursor === undefined || !/^\d+$/.test(rawCursor) ? 0 : Number(rawCursor);
    if (
      (rawCursor !== undefined && !/^\d+$/.test(rawCursor)) ||
      !Number.isSafeInteger(after) ||
      after < 0
    ) {
      return c.text("invalid cursor", 400, NO_STORE);
    }
    const available = await storage.changesSince(authed.id, after, SYNC_LIMITS.changesPerPull);
    const changes: ReturnType<typeof wireChange>[] = [];
    const prefixBytes = utf8.encode('{"changes":[').byteLength;
    let rowsBytes = 0;
    for (const record of available) {
      const change = wireChange(record);
      const encoded = utf8.encode(JSON.stringify(change)).byteLength;
      const nextRowsBytes = rowsBytes + encoded + (changes.length > 0 ? 1 : 0);
      const nextCursor = record.seq.toString();
      const suffixBytes = utf8.encode(`],"cursor":${JSON.stringify(nextCursor)}}`).byteLength;
      if (prefixBytes + nextRowsBytes + suffixBytes > SYNC_LIMITS.pullResponseBytes) {
        if (changes.length === 0) {
          return c.text("stored change exceeds the pull response limit", 500, NO_STORE);
        }
        break;
      }
      changes.push(change);
      rowsBytes = nextRowsBytes;
    }
    const cursor = changes.length > 0 ? (changes[changes.length - 1]?.seq ?? after) : after;
    return c.json({ changes, cursor: cursor.toString() }, 200, NO_STORE);
  });

  return app;
}
