/** Phase 5 DELETE retries must recover an already-applied revocation. */
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it, vi } from "vitest";
import { createShareApp } from "./app";
import { type IdempotencyRecord, MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43);

class RevokeResultFailsOnceStorage extends MemoryStorage {
  private shouldFail = true;

  override async putIdempotent(record: IdempotencyRecord): Promise<void> {
    if (record.status === 204 && this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated revoke-result write failure");
    }
    return super.putIdempotent(record);
  }
}

describe("Phase 5 revoke idempotency", () => {
  it("returns success when the same key retries a revocation applied before its result was stored", async () => {
    const app = createShareApp({ storage: new RevokeResultFailsOnceStorage() });
    const request = (path: string, init?: RequestInit) =>
      app.request(`https://share.test${path}`, init);
    const document: SharedGuide = {
      v: 1,
      kind: "list",
      title: "Revoke interruption",
      blocks: [],
      contentHash: "v1",
    };
    expect(
      (
        await request("/s/lists", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "idempotency-key": "revoke-interruption-create",
            "content-type": "application/json",
          },
          body: JSON.stringify({ desiredSlug: "revoke-interruption", document }),
        })
      ).status,
    ).toBe(201);

    const revoke = () =>
      request("/s/lists/revoke-interruption", {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "if-match": '"1"',
          "idempotency-key": "one-revoke-operation",
        },
      });

    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const interrupted = await revoke();
    logged.mockRestore();
    expect(interrupted.status).toBe(500);
    expect((await request("/s/lists/revoke-interruption")).status).toBe(404);

    expect((await revoke()).status).toBe(204);
  });
});
