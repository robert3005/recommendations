/**
 * Phase 5 first-publish atomicity at the public HTTP boundary. A failed POST
 * must not expose a document or consume its slug before the audit and
 * idempotent success record are both durable.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it, vi } from "vitest";
import { createShareApp } from "./app";
import {
  type AuditEntry,
  type IdempotencyRecord,
  MemoryStorage,
  type StoredDocument,
} from "./storage";

const TOKEN = "a".repeat(43); // shaped like 256 bits of unpadded base64url
const NOW = "2026-07-19T15:00:00.000Z";

function guide(): SharedGuide {
  return { v: 1, kind: "list", title: "Atomic first publish", blocks: [], contentHash: "hash" };
}

class CreateAuditFailsOnceStorage extends MemoryStorage {
  private shouldFail = true;

  override async audit(entry: AuditEntry): Promise<void> {
    if (entry.action === "create" && this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated create-audit write failure");
    }
    await super.audit(entry);
  }
}

class CreateIdempotencyFailsOnceStorage extends MemoryStorage {
  private shouldFail = true;

  override async putIdempotent(record: IdempotencyRecord): Promise<void> {
    if (record.status >= 200 && this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated create-idempotency write failure");
    }
    await super.putIdempotent(record);
  }
}

class DocumentCreateFailsOnceStorage extends MemoryStorage {
  private shouldFail = true;

  override async create(document: StoredDocument): Promise<boolean> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated atomic slug-claim failure");
    }
    return super.create(document);
  }
}

const faultCases = [
  {
    interruption: "the create audit write",
    makeStorage: () => new CreateAuditFailsOnceStorage(),
  },
  {
    interruption: "the final create idempotency write",
    makeStorage: () => new CreateIdempotencyFailsOnceStorage(),
  },
  {
    interruption: "the atomic document claim",
    makeStorage: () => new DocumentCreateFailsOnceStorage(),
  },
] as const;

describe("Phase 5 first-publish atomicity", () => {
  it.each(faultCases)(
    "does not expose or strand a slug when $interruption fails",
    async ({ makeStorage }) => {
      const storage = makeStorage();
      const app = createShareApp({ storage, now: () => NOW });
      const request = (path: string, init?: RequestInit) =>
        app.request(`https://share.test${path}`, init);
      const create = () =>
        request("/s/lists", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "idempotency-key": "atomic-first-publish-job",
            "content-type": "application/json",
          },
          body: JSON.stringify({ desiredSlug: "atomic-first-publish", document: guide() }),
        });

      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const firstAttempt = await create();
      logged.mockRestore();
      expect(firstAttempt.status).toBe(500);

      // A response that never committed its audit/idempotency tuple must not
      // have created a publicly readable, apparently successful publication.
      expect.soft((await request("/s/lists/atomic-first-publish")).status).toBe(404);

      // The persisted bearer token and job id are the client's retry handle.
      // Reusing them must complete the original POST, not collide with its
      // half-written slug claim.
      const retry = await create();
      expect.soft(retry.status).toBe(201);
      expect
        .soft(await retry.text())
        .toBe(JSON.stringify({ slug: "atomic-first-publish", revision: 1 }));

      const published = await request("/s/lists/atomic-first-publish");
      expect(published.status).toBe(200);
      expect.soft((await published.json()) as SharedGuide).toMatchObject({
        title: "Atomic first publish",
      });
    },
  );

  it("scopes a POST idempotency key to its desired slug", async () => {
    const app = createShareApp({ storage: new MemoryStorage(), now: () => NOW });
    const create = (slug: string) =>
      app.request("https://share.test/s/lists", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "idempotency-key": "reused-across-slugs",
          "content-type": "application/json",
        },
        body: JSON.stringify({ desiredSlug: slug, document: guide() }),
      });

    const first = await create("first-idempotency-scope");
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ slug: "first-idempotency-scope", revision: 1 });

    const second = await create("second-idempotency-scope");
    expect(second.status).toBe(201);
    expect.soft(await second.json()).toEqual({
      slug: "second-idempotency-scope",
      revision: 1,
    });
    expect
      .soft((await app.request("https://share.test/s/lists/second-idempotency-scope")).status)
      .toBe(200);
  });
});
