/**
 * Protocol contract (spec/src/storage-sync.md §Multi-device sync): minimal
 * accounts, idempotent push, server-monotonic cursor pull, account isolation,
 * and token hygiene.
 */
import { SYNC_LIMITS, type SyncMutation } from "@placemarks/schemas";
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
    version: { "device-a": 1 },
    row: {
      id: entityId,
      name: "Lisbon",
      marker: { color: "#dc2626", icon: "circle" },
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
    },
  };
}

function noteMutation(index: number, body: string): SyncMutation {
  const id = `note-${index.toString()}`;
  return {
    id: `mutation-${id}`,
    actorId: "device-a",
    table: "notes",
    entityId: id,
    hlc: `${index.toString().padStart(15, "0")}:000000:device-a`,
    version: { "device-a": 1 },
    row: {
      id,
      target: { kind: "place", placeId: "place-1" },
      body,
      mediaIds: [],
      shareable: false,
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
    },
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

    const logout = await app.request("http://sync.test/sync/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(logout.status).toBe(204);
    expect((await pull(first.token)).status).toBe(401);
    expect((await pull(second.token)).status).toBe(200);

    const third = await login("owner@example.com");
    const revokeOthers = await app.request("http://sync.test/sync/logout/others", {
      method: "POST",
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(revokeOthers.status).toBe(204);
    expect((await pull(second.token)).status).toBe(200);
    expect((await pull(third.token)).status).toBe(401);
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

  it("rejects an oversized login body before schema parsing", async () => {
    const response = await app.request("http://sync.test/sync/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", ignored: "🙂".repeat(2_000) }),
    });
    expect(response.status).toBe(413);
    expect(mailer.codes.size).toBe(0);
  });
});

describe("push and pull", () => {
  it("pushes idempotently by mutation id and pulls with a monotonic cursor", async () => {
    const { token } = await login("owner@example.com");
    const first = await push(token, [
      mutation("m1", "list-1", "000000000000001:000000:device-a"),
      mutation("m2", "list-2", "000000000000002:000000:device-a"),
    ]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ acked: ["m1", "m2"] });

    // Idempotent replay: acked again, appended once.
    const replay = await push(token, [mutation("m1", "list-1", "000000000000001:000000:device-a")]);
    expect(await replay.json()).toEqual({ acked: ["m1"] });

    const page1 = await pull(token);
    const body1 = (await page1.json()) as {
      changes: { seq: number; version: Record<string, number> }[];
      cursor: string;
    };
    expect(body1.changes.map((change) => change.seq)).toEqual([1, 2]);
    expect(body1.changes[0]?.version).toEqual({ "device-a": 1 });
    expect(body1.cursor).toBe("2");

    // The cursor hands back only NEWER changes.
    await push(token, [mutation("m3", "list-3", "000000000000003:000000:device-a")]);
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
    await push(alice.token, [mutation("m1", "list-1", "000000000000001:000000:device-a")]);
    const bobPull = await pull(bob.token);
    const body = (await bobPull.json()) as { changes: unknown[] };
    expect(body.changes).toEqual([]);
  });

  it("serializes concurrent pushes and idempotently accepts a concurrent replay", async () => {
    const { token } = await login("owner@example.com");
    const [first, replay, second] = await Promise.all([
      push(token, [mutation("race-1", "list-1", "000000000000001:000000:device-a")]),
      push(token, [mutation("race-1", "list-1", "000000000000001:000000:device-a")]),
      push(token, [mutation("race-2", "list-2", "000000000000002:000000:device-a")]),
    ]);
    expect([first.status, replay.status, second.status]).toEqual([200, 200, 200]);
    const response = await pull(token);
    const body = (await response.json()) as {
      changes: { seq: number; entityId: string }[];
      cursor: string;
    };
    expect(body.changes).toHaveLength(2);
    expect(body.changes.map((change) => change.seq)).toEqual([1, 2]);
    expect(body.changes.map((change) => change.entityId).sort()).toEqual(["list-1", "list-2"]);
    expect(body.cursor).toBe("2");
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
    const trailingJunk = await app.request("http://sync.test/sync/pull?cursor=1junk", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(trailingJunk.status).toBe(400);
    const unsafeCursor = await app.request("http://sync.test/sync/pull?cursor=9007199254740992", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unsafeCursor.status).toBe(400);
  });

  it("measures the request cap in UTF-8 bytes, not UTF-16 code units", async () => {
    const { token } = await login("owner@example.com");
    const oversized = "🙂".repeat(Math.ceil(SYNC_LIMITS.requestBytes / 4));
    const response = await app.request("http://sync.test/sync/push", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: `{"padding":"${oversized}"}`,
    });
    expect(response.status).toBe(413);
  });

  it("pages a large log by encoded response bytes without skipping a cursor", async () => {
    const { token } = await login("owner@example.com");
    const body = "🙂".repeat(200_000);
    for (let index = 1; index <= 3; index += 1) {
      expect((await push(token, [noteMutation(index, body)])).status).toBe(200);
    }

    let cursor: string | undefined;
    const ids: string[] = [];
    let nonemptyPages = 0;
    for (let page = 0; page < 10; page += 1) {
      const response = await pull(token, cursor);
      const text = await response.text();
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
        SYNC_LIMITS.pullResponseBytes,
      );
      const payload = JSON.parse(text) as {
        changes: { entityId: string }[];
        cursor: string;
      };
      if (payload.changes.length === 0) break;
      nonemptyPages += 1;
      ids.push(...payload.changes.map((change) => change.entityId));
      expect(payload.cursor).not.toBe(cursor);
      cursor = payload.cursor;
    }
    expect(nonemptyPages).toBeGreaterThan(1);
    expect(ids).toEqual(["note-1", "note-2", "note-3"]);
  });
});
