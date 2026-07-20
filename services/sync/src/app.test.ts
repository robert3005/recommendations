/**
 * Protocol contract (spec/src/storage-sync.md §Multi-device sync): minimal
 * accounts, idempotent push, server-monotonic cursor pull, account isolation,
 * and token hygiene.
 */
import type { SyncMutation } from "@placemarks/schemas";
import { beforeEach, describe, expect, it } from "vitest";
import { createSyncApp } from "./app";
import { MemorySyncStorage } from "./storage";

class RecordingMailer {
  codes = new Map<string, string>();
  async send(email: string, code: string): Promise<void> {
    this.codes.set(email, code);
  }
}

let storage: MemorySyncStorage;
let mailer: RecordingMailer;
let app: ReturnType<typeof createSyncApp>;

beforeEach(() => {
  storage = new MemorySyncStorage();
  mailer = new RecordingMailer();
  app = createSyncApp({ storage, mailer });
});

async function login(email: string): Promise<{ accountId: string; token: string }> {
  const request = await app.request("http://sync.test/sync/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(request.status).toBe(204);
  const code = mailer.codes.get(email.toLowerCase());
  if (!code) throw new Error("no code delivered");
  const complete = await app.request("http://sync.test/sync/login/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  expect(complete.status).toBe(200);
  return (await complete.json()) as { accountId: string; token: string };
}

function mutation(id: string, entityId: string, hlc: string): SyncMutation {
  return {
    id,
    actorId: "device-a",
    table: "lists",
    entityId,
    hlc,
    row: { id: entityId, name: "Lisbon", updatedAt: "2026-07-20T10:00:00.000Z" },
  };
}

async function push(token: string, mutations: SyncMutation[]) {
  return app.request("http://sync.test/sync/push", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ mutations }),
  });
}

async function pull(token: string, cursor?: string) {
  const url = new URL("http://sync.test/sync/pull");
  if (cursor) url.searchParams.set("cursor", cursor);
  return app.request(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("accounts", () => {
  it("logs in via a single-use emailed code and mints a ≥256-bit bearer", async () => {
    const { accountId, token } = await login("owner@example.com");
    expect(accountId).toBeTruthy();
    expect(token.length).toBeGreaterThanOrEqual(43);
    // The code was consumed: replaying the completion fails.
    const replay = await app.request("http://sync.test/sync/login/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "owner@example.com",
        code: mailer.codes.get("owner@example.com"),
      }),
    });
    expect(replay.status).toBe(401);
  });

  it("mints one DEVICE token per login and keeps one account per email", async () => {
    const first = await login("owner@example.com");
    const second = await login("owner@example.com");
    expect(second.accountId).toBe(first.accountId);
    expect(second.token).not.toBe(first.token);
    // Both devices stay signed into the one scope concurrently — that is the
    // point of multi-device sync.
    expect((await pull(first.token)).status).toBe(200);
    expect((await pull(second.token)).status).toBe(200);
  });

  it("rejects a wrong code without leaking whether the email exists", async () => {
    await app.request("http://sync.test/sync/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com" }),
    });
    const wrong = await app.request("http://sync.test/sync/login/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", code: "000000" }),
    });
    expect(wrong.status).toBe(401);
    // The single-use code burned on the wrong attempt.
    const rightAfterWrong = await app.request("http://sync.test/sync/login/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "owner@example.com",
        code: mailer.codes.get("owner@example.com"),
      }),
    });
    expect(rightAfterWrong.status).toBe(401);
  });
});

describe("push and pull", () => {
  it("pushes idempotently by mutation id and pulls with a monotonic cursor", async () => {
    const { token } = await login("owner@example.com");
    const first = await push(token, [
      mutation("m1", "list-1", "0001:a"),
      mutation("m2", "list-2", "0002:a"),
    ]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ acked: ["m1", "m2"] });

    // Idempotent replay: acked again, appended once.
    const replay = await push(token, [mutation("m1", "list-1", "0001:a")]);
    expect(await replay.json()).toEqual({ acked: ["m1"] });

    const page1 = await pull(token);
    const body1 = (await page1.json()) as { changes: { seq: number }[]; cursor: string };
    expect(body1.changes.map((change) => change.seq)).toEqual([1, 2]);
    expect(body1.cursor).toBe("2");

    // The cursor hands back only NEWER changes.
    await push(token, [mutation("m3", "list-3", "0003:a")]);
    const page2 = await pull(token, body1.cursor);
    const body2 = (await page2.json()) as { changes: { seq: number }[]; cursor: string };
    expect(body2.changes.map((change) => change.seq)).toEqual([3]);
    expect(body2.cursor).toBe("3");

    // An empty pull keeps the cursor where it was.
    const page3 = await pull(token, body2.cursor);
    const body3 = (await page3.json()) as { changes: unknown[]; cursor: string };
    expect(body3.changes).toEqual([]);
    expect(body3.cursor).toBe("3");
  });

  it("isolates accounts: one bearer never sees another's changes", async () => {
    const alice = await login("alice@example.com");
    const bob = await login("bob@example.com");
    await push(alice.token, [mutation("m1", "list-1", "0001:a")]);
    const bobPull = await pull(bob.token);
    const body = (await bobPull.json()) as { changes: unknown[] };
    expect(body.changes).toEqual([]);
  });

  it("rejects unauthorized and malformed traffic", async () => {
    expect((await pull("x".repeat(43))).status).toBe(401);
    const { token } = await login("owner@example.com");
    const bad = await app.request("http://sync.test/sync/push", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mutations: [{ id: "x", table: "not-a-table" }] }),
    });
    expect(bad.status).toBe(400);
    const badCursor = await app.request("http://sync.test/sync/pull?cursor=-1", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(badCursor.status).toBe(400);
  });
});
