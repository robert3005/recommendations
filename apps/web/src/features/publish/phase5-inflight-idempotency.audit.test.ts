/** A key already sent for one payload must never be reused after an in-flight edit. */
import { markerAt } from "@placemarks/domain";
import { createShareApp, MemoryStorage } from "@placemarks/share-service";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { publishList } from "./publication";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T11:00:00.000Z";

describe("Phase 5 in-flight idempotency-key hygiene", () => {
  it("publishes an edit made while the previous payload is in flight under a fresh key", async () => {
    const repo = new DexieRepository(`phase5-inflight-key-${crypto.randomUUID()}`);
    const storage = new MemoryStorage();
    const app = createShareApp({ storage });
    const serviceFetch: typeof fetch = async (input, init) =>
      app.request(new URL(String(input), "https://share.test").toString(), init);
    const seenKeys: string[] = [];
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const delayedFetch: typeof fetch = async (input, init) => {
      const key = new Headers(init?.headers).get("idempotency-key");
      if (key) seenKeys.push(key);
      signalStarted?.();
      await requestGate;
      return serviceFetch(input, init);
    };
    const trackedFetch: typeof fetch = async (input, init) => {
      const key = new Headers(init?.headers).get("idempotency-key");
      if (key) seenKeys.push(key);
      return serviceFetch(input, init);
    };

    try {
      await repo.createList({
        id: "list-1",
        name: "In-flight guide",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "First place", lat: 38.71, lng: -9.14 } },
        NOW,
      );

      const firstPublish = publishList(repo, "list-1", NOW, delayedFetch);
      await started;
      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Added while publishing", lat: 38.72, lng: -9.15 } },
        LATER,
      );
      releaseRequest?.();
      await firstPublish;

      await publishList(repo, "list-1", LATER, trackedFetch);

      expect(new Set(seenKeys).size).toBe(2);
      const stored = await storage.get("list", "in-flight-guide");
      expect(stored?.revision).toBe(2);
      expect((JSON.parse(stored?.body ?? "{}") as { blocks?: unknown[] }).blocks).toHaveLength(2);
    } finally {
      releaseRequest?.();
      repo.db.close();
    }
  });
});
