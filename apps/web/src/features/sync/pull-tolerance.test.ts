/**
 * A single unreadable row must not wedge an account's pull.
 *
 * Regression: `pull()` validated the whole page with `pullResponseSchema.parse`,
 * so one malformed row threw before the cursor could advance — and because the
 * cursor never moved, the next pull fetched the same page and threw again.
 * That is unrecoverable by construction: the account can never sync again.
 *
 * Rows are now validated one at a time. A bad row is set aside in the conflicts
 * inbox (inspectable, not silently dropped), the good rows apply, and the cursor
 * advances.
 */
import { markerAt } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { completeLogin, requestLoginCode, syncNow } from "./engine";

const NOW = "2026-07-20T12:00:00.000Z";

/**
 * A sync service that serves one page containing a good list row, a structurally
 * invalid row, and a row for a table that does not exist.
 */
function poisonedService(): { fetcher: typeof fetch; pulls: number } {
  const state = { pulls: 0 };
  const goodList = {
    seq: 1,
    table: "lists",
    entityId: "list-1",
    actorId: "peer",
    hlc: "999999999999999:000000:peer",
    version: { peer: 1 },
    row: {
      id: "list-1",
      name: "Arrived intact",
      marker: markerAt(3),
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  const fetcher: typeof fetch = (input, _init) => {
    const url = String(input);
    if (url.includes("/sync/login/complete")) {
      return Promise.resolve(Response.json({ accountId: "account-1", token: "t".repeat(43) }));
    }
    if (url.includes("/sync/login")) return Promise.resolve(Response.json({ ok: true }));
    if (url.includes("/sync/push")) {
      return Promise.resolve(Response.json({ acked: [] }));
    }
    if (url.includes("/sync/pull")) {
      state.pulls += 1;
      if (new URL(url, "https://sync.test").searchParams.get("cursor") === "c1") {
        return Promise.resolve(Response.json({ changes: [], cursor: "c1" }));
      }
      return Promise.resolve(
        Response.json({
          changes: [
            goodList,
            // A list row whose marker is missing its icon — the row schema rejects it.
            {
              ...goodList,
              seq: 2,
              entityId: "list-2",
              row: { ...goodList.row, id: "list-2", marker: {} },
            },
            // A table nobody knows about.
            { ...goodList, seq: 3, table: "gremlins", entityId: "g-1" },
          ],
          cursor: "c1",
        }),
      );
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  };
  return {
    fetcher,
    get pulls() {
      return state.pulls;
    },
  } as { fetcher: typeof fetch; pulls: number };
}

describe("pull tolerance", () => {
  it("applies the readable rows, files the rest, and advances the cursor", async () => {
    const repo = new DexieRepository(`pull-tolerance-${crypto.randomUUID()}`, {
      actorId: "local-actor",
    });
    const wire = poisonedService();
    try {
      await requestLoginCode("owner@example.test", wire.fetcher);
      await completeLogin(repo, "owner@example.test", "123456", wire.fetcher);

      await syncNow(repo, undefined, wire.fetcher);

      // The good row landed.
      expect(await repo.getList("list-1")).toMatchObject({ name: "Arrived intact" });
      // The bad ones were preserved rather than dropped or retried forever.
      const filed = (await repo.db.syncConflicts.toArray()).filter(
        (row) => row.kind === "unreadable-row",
      );
      expect(filed).toHaveLength(2);
      expect(filed.map((row) => row.body).join(" ")).toContain("gremlins");
      // The cursor advanced past the poisoned page.
      expect((await repo.db.syncState.get("sync"))?.cursor).toBe("c1");

      // And a second sync is not stuck re-fetching the same page.
      const before = wire.pulls;
      await syncNow(repo, undefined, wire.fetcher);
      expect(wire.pulls).toBeGreaterThan(before);
      expect(
        (await repo.db.syncConflicts.toArray()).filter((row) => row.kind === "unreadable-row"),
      ).toHaveLength(2);
    } finally {
      repo.db.close();
    }
  });
});
