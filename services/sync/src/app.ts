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
  pushRequestSchema,
  SYNC_LIMITS,
} from "@placemarks/schemas";
import { Hono } from "hono";
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S{43,512})$/);
  return match?.[1];
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
    const parsed = loginRequestSchema.safeParse(await c.req.json().catch(() => undefined));
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
    const parsed = loginCompleteRequestSchema.safeParse(await c.req.json().catch(() => undefined));
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

  // Idempotent push: a re-sent mutation id acks without re-appending.
  app.post("/sync/push", async (c) => {
    const authed = await account(c.req.header("authorization"));
    if (!authed) return c.text("unauthorized", 401, NO_STORE);
    const body = await c.req.text();
    if (body.length > SYNC_LIMITS.requestBytes) {
      return c.text("request too large", 413, NO_STORE);
    }
    const parsed = pushRequestSchema.safeParse(
      (() => {
        try {
          return JSON.parse(body) as unknown;
        } catch {
          return undefined;
        }
      })(),
    );
    if (!parsed.success) return c.text("invalid request", 400, NO_STORE);
    const acked: string[] = [];
    for (const mutation of parsed.data.mutations) {
      if (!(await storage.hasMutation(authed.id, mutation.id))) {
        await storage.appendChange({
          accountId: authed.id,
          mutationId: mutation.id,
          actorId: mutation.actorId,
          table: mutation.table,
          entityId: mutation.entityId,
          hlc: mutation.hlc,
          row: mutation.row,
          recordedAt: now(),
        });
      }
      acked.push(mutation.id);
    }
    return c.json({ acked }, 200, NO_STORE);
  });

  // Server-monotonic cursor pull.
  app.get("/sync/pull", async (c) => {
    const authed = await account(c.req.header("authorization"));
    if (!authed) return c.text("unauthorized", 401, NO_STORE);
    const rawCursor = c.req.query("cursor");
    const after = rawCursor ? Number.parseInt(rawCursor, 10) : 0;
    if (Number.isNaN(after) || after < 0) return c.text("invalid cursor", 400, NO_STORE);
    const changes = await storage.changesSince(authed.id, after, SYNC_LIMITS.changesPerPull);
    const cursor = changes.length > 0 ? (changes[changes.length - 1]?.seq ?? after) : after;
    return c.json(
      {
        changes: changes.map((change) => ({
          seq: change.seq,
          table: change.table,
          entityId: change.entityId,
          hlc: change.hlc,
          actorId: change.actorId,
          row: change.row,
        })),
        cursor: cursor.toString(),
      },
      200,
      NO_STORE,
    );
  });

  return app;
}
