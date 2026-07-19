/** Concurrent retries sharing one idempotency key must not erase the winner's acknowledgement. */
import { describe, expect, it } from "vitest";
import {
  type CreateCommit,
  MemoryStorage,
  type StoredDocument,
  type UpdateCommit,
} from "./storage";

const DOCUMENT: StoredDocument = {
  slug: "same-key",
  kind: "list",
  revision: 1,
  tokenHash: "token-hash",
  body: "v1",
  createdAt: "2026-07-19T10:00:00.000Z",
  updatedAt: "2026-07-19T10:00:00.000Z",
  revoked: false,
};

class SimultaneousCreateStorage extends MemoryStorage {
  private arrivals = 0;
  private release!: () => void;
  private readonly bothArrived = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async create(document: StoredDocument): Promise<boolean> {
    this.arrivals += 1;
    if (this.arrivals === 2) this.release();
    await this.bothArrived;
    return super.create(document);
  }
}

class SimultaneousUpdateStorage extends MemoryStorage {
  private arrivals = 0;
  private release!: () => void;
  private readonly bothArrived = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async update(...args: Parameters<MemoryStorage["update"]>) {
    this.arrivals += 1;
    if (this.arrivals === 2) this.release();
    await this.bothArrived;
    return super.update(...args);
  }
}

const createInput = (reservationKey: string): CreateCommit => ({
  audit: {
    at: DOCUMENT.createdAt,
    slug: DOCUMENT.slug,
    kind: DOCUMENT.kind,
    action: "create",
    revision: 1,
  },
  reservationKey,
  document: DOCUMENT,
  response: JSON.stringify({ slug: DOCUMENT.slug, revision: 1 }),
});

const updateInput = (reservationKey: string): UpdateCommit => ({
  audit: {
    at: "2026-07-19T11:00:00.000Z",
    slug: DOCUMENT.slug,
    kind: DOCUMENT.kind,
    action: "update",
    revision: 2,
  },
  reservationKey,
  kind: DOCUMENT.kind,
  slug: DOCUMENT.slug,
  expectedRevision: 1,
  body: "v2",
  updatedAt: "2026-07-19T11:00:00.000Z",
  response: JSON.stringify({ slug: DOCUMENT.slug, revision: 2 }),
});

describe("Phase 5 in-memory same-key commit acknowledgements", () => {
  it("keeps the winning create acknowledgement when an identical retry loses the slug claim", async () => {
    const storage = new SimultaneousCreateStorage();
    const input = createInput("same-create-job");

    await Promise.all([storage.createCommit(input), storage.createCommit(input)]);

    await expect(storage.getIdempotent(input.reservationKey)).resolves.toEqual({
      key: input.reservationKey,
      response: input.response,
      status: 201,
    });
  });

  it("keeps the winning update acknowledgement when an identical retry loses the revision race", async () => {
    const storage = new SimultaneousUpdateStorage();
    const input = updateInput("same-update-job");
    await storage.create(DOCUMENT);

    await Promise.all([storage.updateCommit(input), storage.updateCommit(input)]);

    await expect(storage.getIdempotent(input.reservationKey)).resolves.toEqual({
      key: input.reservationKey,
      response: input.response,
      status: 200,
    });
  });
});
