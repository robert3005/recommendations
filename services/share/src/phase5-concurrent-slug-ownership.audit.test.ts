/** An atomic slug claim must have exactly one creator, even under concurrency. */
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { MemoryStorage } from "./storage";

const FIRST_TOKEN = "a".repeat(43);
const SECOND_TOKEN = "b".repeat(43);

class SimultaneousClaimStorage extends MemoryStorage {
  private initialChecks = 0;
  private releaseChecks!: () => void;
  private readonly bothChecked = new Promise<void>((resolve) => {
    this.releaseChecks = resolve;
  });

  override async get(...args: Parameters<MemoryStorage["get"]>) {
    const current = await super.get(...args);
    if (current || args[1] !== "one-atomic-owner" || this.initialChecks >= 2) return current;

    this.initialChecks += 1;
    if (this.initialChecks === 2) this.releaseChecks();
    await this.bothChecked;
    return undefined;
  }
}

describe("Phase 5 concurrent slug ownership", () => {
  it("acknowledges only the creator whose bearer token won the atomic claim", async () => {
    const app = createShareApp({ storage: new SimultaneousClaimStorage() });
    const document: SharedGuide = {
      v: 1,
      kind: "list",
      title: "One owner",
      blocks: [],
      contentHash: "same-document",
    };
    const create = (token: string, key: string) =>
      app.request("https://share.test/s/lists", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": key,
          "content-type": "application/json",
        },
        body: JSON.stringify({ desiredSlug: "one-atomic-owner", document }),
      });

    const attempts = await Promise.all([
      create(FIRST_TOKEN, "first-creator-job"),
      create(SECOND_TOKEN, "second-creator-job"),
    ]);

    expect(attempts.map(({ status }) => status).sort()).toEqual([201, 409]);
  });
});
