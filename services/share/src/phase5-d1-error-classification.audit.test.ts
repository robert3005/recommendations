/** D1 failures must not be mislabeled as ordinary slug collisions. */
import { describe, expect, it } from "vitest";
import { type D1Like, D1Storage } from "./d1";

describe("Phase 5 D1 error classification", () => {
  it("propagates a database failure while claiming a slug", async () => {
    const outage = new Error("D1_ERROR: database unavailable");
    const statement = {
      bind: () => statement,
      run: async () => Promise.reject(outage),
      first: async () => null,
    };
    const db: D1Like = { prepare: () => statement };
    const storage = new D1Storage(db);

    await expect(
      storage.create({
        slug: "not-a-collision",
        kind: "list",
        revision: 1,
        tokenHash: "hash",
        body: "{}",
        createdAt: "2026-07-19T15:00:00.000Z",
        updatedAt: "2026-07-19T15:00:00.000Z",
        revoked: false,
      }),
    ).rejects.toThrow(/database unavailable/i);
  });
});
