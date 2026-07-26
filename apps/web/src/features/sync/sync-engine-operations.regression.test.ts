import type { LocalMutation, SyncTransport } from "@placemarks/domain";
import { markerAt } from "@placemarks/domain";
import { SYNC_LIMITS } from "@placemarks/schemas";
import { describe, expect, it, vi } from "vitest";
import { DexieRepository } from "../../data/repo";
import { signOut, signOutOtherDevices, syncNow, takePushBatch } from "./engine";

const NOW = "2026-07-20T10:00:00.000Z";
const TOKEN = "t".repeat(43);

async function signedRepo(label: string): Promise<DexieRepository> {
  const repo = new DexieRepository(`${label}-${crypto.randomUUID()}`, {
    actorId: `${label}-actor`,
  });
  await repo.db.syncState.put({
    id: "sync",
    actorId: repo.actorId,
    accountId: "account-1",
    token: TOKEN,
    bootstrappedAccountId: "account-1",
  });
  await repo.createList({
    id: "list-1",
    name: "Queued",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  return repo;
}

function successfulTransport(): SyncTransport {
  return {
    push: async (mutations) => ({ acked: mutations.map((mutation) => mutation.id) }),
    pull: async () => ({ changes: [], cursor: "0" }),
  };
}

describe("sync engine operational boundaries", () => {
  it("coalesces concurrent syncNow triggers into one flight", async () => {
    const repo = await signedRepo("single-flight");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const push = vi.fn(async (mutations: LocalMutation[]) => {
      await gate;
      return { acked: mutations.map((mutation) => mutation.id) };
    });
    const transport: SyncTransport = {
      push,
      pull: async () => ({ changes: [], cursor: "0" }),
    };
    try {
      const first = syncNow(repo, transport);
      const second = syncNow(repo, transport);
      await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
      release?.();
      await expect(first).resolves.toMatchObject({ pushed: 1 });
      await expect(second).resolves.toMatchObject({ pushed: 1 });
      expect(push).toHaveBeenCalledOnce();
    } finally {
      release?.();
      repo.db.close();
    }
  });

  it("persists only a sanitized failure and clears it after success in the same scope", async () => {
    const repo = await signedRepo("last-error");
    const secret = "https://private.example/path?token=super-secret";
    const failure: SyncTransport = {
      push: async () => {
        throw new Error(secret);
      },
      pull: async () => ({ changes: [], cursor: "0" }),
    };
    try {
      await expect(syncNow(repo, failure)).rejects.toThrow(secret);
      const failedState = await repo.db.syncState.get("sync");
      expect(failedState?.lastError).toBe("Sync failed. Check your connection and try again.");
      expect(failedState?.lastError).not.toContain("super-secret");

      await expect(syncNow(repo, successfulTransport())).resolves.toMatchObject({ pushed: 1 });
      expect((await repo.db.syncState.get("sync"))?.lastError).toBeUndefined();
    } finally {
      repo.db.close();
    }
  });

  it("does not delete acknowledgements or overwrite state after the account changes mid-flight", async () => {
    const repo = await signedRepo("scope-race");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const push = vi.fn(async (mutations: LocalMutation[]) => {
      await gate;
      return { acked: mutations.map((mutation) => mutation.id) };
    });
    const transport: SyncTransport = {
      push,
      pull: async () => ({ changes: [], cursor: "0" }),
    };
    try {
      const flight = syncNow(repo, transport);
      await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
      await repo.db.syncState.put({
        id: "sync",
        actorId: repo.actorId,
        accountId: "account-2",
        token: "n".repeat(43),
      });
      release?.();
      await expect(flight).rejects.toThrow(/signed-in account changed/);
      expect(await repo.db.mutationOutbox.count()).toBe(1);
      expect(await repo.db.syncState.get("sync")).toMatchObject({
        accountId: "account-2",
        token: "n".repeat(43),
      });
      expect((await repo.db.syncState.get("sync"))?.lastError).toBeUndefined();
    } finally {
      release?.();
      repo.db.close();
    }
  });

  it("waits out an old-scope pull then immediately syncs the newly selected account", async () => {
    const repo = await signedRepo("scope-replacement");
    let releasePull: (() => void) | undefined;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const oldPull = vi.fn(async () => {
      await pullGate;
      return { changes: [], cursor: "old-cursor" };
    });
    const oldTransport: SyncTransport = {
      push: async (mutations) => ({ acked: mutations.map((mutation) => mutation.id) }),
      pull: oldPull,
    };
    const newPull = vi.fn(async () => ({ changes: [], cursor: "new-cursor" }));
    const newTransport: SyncTransport = {
      push: async (mutations) => ({ acked: mutations.map((mutation) => mutation.id) }),
      pull: newPull,
    };
    try {
      const oldFlight = syncNow(repo, oldTransport);
      await vi.waitFor(() => expect(oldPull).toHaveBeenCalledOnce());
      await repo.db.syncState.put({
        id: "sync",
        actorId: repo.actorId,
        accountId: "account-2",
        token: "n".repeat(43),
        bootstrappedAccountId: "account-2",
      });
      const replacement = syncNow(repo, newTransport);
      releasePull?.();
      await expect(oldFlight).rejects.toThrow(/signed-in account changed/);
      await expect(replacement).resolves.toEqual({ pushed: 0, applied: 0 });
      expect(newPull).toHaveBeenCalledOnce();
      expect(await repo.db.syncState.get("sync")).toMatchObject({
        accountId: "account-2",
        cursor: "new-cursor",
      });
    } finally {
      releasePull?.();
      repo.db.close();
    }
  });

  it("keeps pulling short byte-bounded pages until an empty page confirms the tail", async () => {
    const repo = await signedRepo("byte-paged-pull");
    const remoteList = (id: string, index: number) => ({
      table: "lists" as const,
      entityId: id,
      actorId: "remote",
      hlc: `${index.toString().padStart(15, "0")}:000000:remote`,
      version: { remote: 1 },
      row: {
        id,
        name: id,
        marker: markerAt(index),
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    const pull = vi.fn(async (cursor?: string) => {
      if (cursor === undefined) return { changes: [remoteList("remote-1", 1)], cursor: "1" };
      if (cursor === "1") return { changes: [remoteList("remote-2", 2)], cursor: "2" };
      return { changes: [], cursor: "2" };
    });
    const transport: SyncTransport = {
      push: async (mutations) => ({ acked: mutations.map((mutation) => mutation.id) }),
      pull,
    };
    try {
      await expect(syncNow(repo, transport)).resolves.toMatchObject({ applied: 2 });
      expect(pull).toHaveBeenCalledTimes(3);
      expect((await repo.listLists()).map((list) => list.id).sort()).toEqual([
        "list-1",
        "remote-1",
        "remote-2",
      ]);
      expect((await repo.db.syncState.get("sync"))?.cursor).toBe("2");
    } finally {
      repo.db.close();
    }
  });

  it("batches by exact UTF-8 bytes and reports one poison row before transport", () => {
    const mutation = (id: string, body: string): LocalMutation => ({
      id,
      actorId: "device-a",
      table: "notes",
      entityId: id,
      hlc: `000001753006400:000000:device-a`,
      version: { "device-a": 1 },
      row: { id, body },
    });
    const first = mutation("first", "🙂".repeat(300_000));
    const second = mutation("second", "🙂".repeat(300_000));
    const batch = takePushBatch([first, second]);
    expect(batch.map((row) => row.id)).toEqual(["first"]);
    expect(
      new TextEncoder().encode(JSON.stringify({ mutations: batch })).byteLength,
    ).toBeLessThanOrEqual(SYNC_LIMITS.requestBytes);
    expect(() => takePushBatch([mutation("poison", "🙂".repeat(530_000))])).toThrow(
      /single queued note.*2 MiB.*Shorten/i,
    );
  });

  it("revokes the server bearer before clearing this device's local scope", async () => {
    const repo = await signedRepo("logout-client");
    let authorization: string | undefined;
    const fetcher = ((_: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    try {
      await signOut(repo, fetcher);
      expect(authorization).toBe(`Bearer ${TOKEN}`);
      expect(await repo.db.syncState.get("sync")).toMatchObject({ actorId: repo.actorId });
      expect((await repo.db.syncState.get("sync"))?.token).toBeUndefined();
    } finally {
      repo.db.close();
    }
  });

  it("revokes other device sessions without clearing the caller's scope", async () => {
    const repo = await signedRepo("logout-others-client");
    let requested = "";
    const fetcher = ((input: RequestInfo | URL) => {
      requested = String(input);
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    try {
      await signOutOtherDevices(repo, fetcher);
      expect(requested).toContain("/sync/logout/others");
      expect(await repo.db.syncState.get("sync")).toMatchObject({
        accountId: "account-1",
        token: TOKEN,
      });
    } finally {
      repo.db.close();
    }
  });
});
