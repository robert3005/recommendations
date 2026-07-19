/** The replayable POST result is the commit acknowledgement, so it lands last. */
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import {
  type AuditEntry,
  type IdempotencyRecord,
  MemoryStorage,
  type StoredDocument,
} from "./storage";

const TOKEN = "a".repeat(43);

class OrderedCreateStorage extends MemoryStorage {
  readonly events: string[] = [];

  override async audit(entry: AuditEntry): Promise<void> {
    if (entry.action === "create") this.events.push("audit");
    return super.audit(entry);
  }

  override async putIdempotent(record: IdempotencyRecord): Promise<void> {
    this.events.push(record.status >= 200 ? "replayable-success" : "key-reservation");
    return super.putIdempotent(record);
  }

  override async create(document: StoredDocument): Promise<boolean> {
    this.events.push("atomic-slug-claim");
    return super.create(document);
  }
}

describe("Phase 5 create commit ordering", () => {
  it("claims the slug before storing a replayable success", async () => {
    const storage = new OrderedCreateStorage();
    const app = createShareApp({ storage });
    const document: SharedGuide = {
      v: 1,
      title: "Ordered first publish",
      blocks: [],
      contentHash: "v1",
    };

    const response = await app.request("https://share.test/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "idempotency-key": "ordered-create-job",
        "content-type": "application/json",
      },
      body: JSON.stringify({ desiredSlug: "ordered-first-publish", document }),
    });

    expect(response.status).toBe(201);
    const audit = storage.events.indexOf("audit");
    const reservation = storage.events.indexOf("key-reservation");
    const claim = storage.events.indexOf("atomic-slug-claim");
    const success = storage.events.indexOf("replayable-success");

    // The spec requires both durable prerequisites before the claim and the
    // replayable acknowledgement last. It does not prescribe whether audit or
    // reservation is written first inside that prerequisite pair.
    expect(audit).toBeGreaterThanOrEqual(0);
    expect(reservation).toBeGreaterThanOrEqual(0);
    expect(audit).toBeLessThan(claim);
    expect(reservation).toBeLessThan(claim);
    expect(claim).toBeLessThan(success);
  });
});
