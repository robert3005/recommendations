/** Only the documents primary-key collision may be reported as a taken slug. */
import { describe, expect, it } from "vitest";
import { type D1Like, D1Storage } from "./d1";

describe("Phase 5 D1 non-collision constraint handling", () => {
  it("propagates a CHECK constraint failure instead of reporting a slug collision", async () => {
    const failure = new Error("D1_ERROR: CHECK constraint failed: documents.kind");
    const statement = {
      bind: () => statement,
      run: async () => Promise.reject(failure),
      first: async () => null,
    };
    const storage = new D1Storage({ prepare: () => statement } satisfies D1Like);

    await expect(
      storage.create({
        slug: "not-a-primary-key-collision",
        kind: "list",
        revision: 1,
        tokenHash: "hash",
        body: "{}",
        createdAt: "2026-07-19T15:00:00.000Z",
        updatedAt: "2026-07-19T15:00:00.000Z",
        revoked: false,
      }),
    ).rejects.toThrow(/CHECK constraint/i);
  });
});
