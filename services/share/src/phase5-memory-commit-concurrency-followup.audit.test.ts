/** The in-memory share adapter must not roll back a concurrent winning commit. */
import { describe, expect, it } from "vitest";
import {
  type CreateCommit,
  MemoryStorage,
  type StoredDocument,
  type UpdateCommit,
} from "./storage";

const DOCUMENT: StoredDocument = {
  slug: "concurrent-commit",
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

function createInput(reservationKey: string): CreateCommit {
  return {
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
  };
}

function updateInput(reservationKey: string, body: string): UpdateCommit {
  return {
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
    body,
    updatedAt: "2026-07-19T11:00:00.000Z",
    response: JSON.stringify({ slug: DOCUMENT.slug, revision: 2 }),
  };
}

describe("Phase 5 in-memory transactional commit concurrency", () => {
  it("does not let a losing slug claim erase the winning document", async () => {
    const storage = new SimultaneousCreateStorage();

    const outcomes = await Promise.all([
      storage.createCommit(createInput("create-job-a")),
      storage.createCommit(createInput("create-job-b")),
    ]);

    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "collision")).toHaveLength(1);
    await expect(storage.get(DOCUMENT.kind, DOCUMENT.slug)).resolves.toMatchObject(DOCUMENT);
  });

  it("does not let a losing conditional update restore over the winner", async () => {
    const storage = new SimultaneousUpdateStorage();
    await storage.create(DOCUMENT);

    const outcomes = await Promise.all([
      storage.updateCommit(updateInput("update-job-a", "v2-a")),
      storage.updateCommit(updateInput("update-job-b", "v2-b")),
    ]);
    const winner = outcomes.find(
      (outcome): outcome is StoredDocument => outcome !== "conflict" && outcome !== "missing",
    );

    expect(winner).toBeDefined();
    expect(outcomes.filter((outcome) => outcome === "conflict")).toHaveLength(1);
    await expect(storage.get(DOCUMENT.kind, DOCUMENT.slug)).resolves.toMatchObject({
      revision: 2,
      body: winner?.body,
    });
  });
});
