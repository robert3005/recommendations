import { describe, expect, it, vi } from "vitest";
import { type PgLike, PgSyncStorage } from "./pg";

describe("PgSyncStorage appendChange", () => {
  it("allocates the cursor and accepts/replays the mutation in one row-locked SQL statement", async () => {
    const query = vi.fn<PgLike["query"]>().mockResolvedValue({ rows: [] });
    const storage = new PgSyncStorage({ query });

    await storage.appendChange({
      accountId: "account-1",
      mutationId: "mutation-1",
      actorId: "device-a",
      table: "lists",
      entityId: "list-1",
      hlc: "000001753006400:000000:device-a",
      version: { "device-a": 1 },
      row: { id: "list-1" },
      recordedAt: "2026-07-20T10:00:00.000Z",
    });

    expect(query).toHaveBeenCalledOnce();
    const sql = query.mock.calls[0]?.[0] ?? "";
    expect(sql).toMatch(/INSERT INTO account_cursors/);
    expect(sql).toMatch(/last_seq = account_cursors\.last_seq \+ 1/);
    expect(sql).toMatch(/hlc, version, row/);
    expect(sql).toMatch(/ON CONFLICT \(account_id, mutation_id\) DO NOTHING/);
    expect(sql).not.toMatch(/MAX\(seq\)/);
  });
});
