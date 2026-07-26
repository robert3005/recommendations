/** Focused regressions for the Phase 5 client publication contract. */
import { markerAt, type ResolvedPoi } from "@placemarks/domain";
import { createShareApp, MemoryStorage } from "@placemarks/share-service";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { PublishControls } from "./PublishControls";
import {
  publicationForList,
  publishList,
  revokePublication,
  runPublicationOutbox,
} from "./publication";

const phase5Viewer = vi.hoisted(() => ({
  resolveExact: vi.fn(),
  searchNearby: vi.fn(async () => []),
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ slug: "field-notes" }),
}));

vi.mock("../../providers", () => ({
  poiResolver: {
    resolveExact: phase5Viewer.resolveExact,
    searchNearby: phase5Viewer.searchNearby,
    discover: vi.fn(async () => ({ pois: [], truncated: false })),
  },
}));

const NOW = "2026-07-19T16:00:00.000Z";
const LATER = "2026-07-19T17:00:00.000Z";
const LATEST = "2026-07-19T18:00:00.000Z";

function poi(): ResolvedPoi {
  return {
    osmRef: { type: "node", id: "101" },
    name: "Café Central",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    address: "Rua Example 12, Lisboa",
    identityTags: { name: "Café Central", wikidata: "Q123" },
    resolvedAt: NOW,
  };
}

function _sharedOsmNoteDocument() {
  const evidence = {
    osmRef: { type: "node", id: "101" },
    source: "OpenStreetMap",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name: "Copied old café",
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    address: "Copied old address",
    observedAt: "2020-01-02T03:04:05.000Z",
  } as const;
  return {
    v: 1,
    slug: "field-notes",
    title: "Field notes",
    context: {
      kind: "place",
      place: {
        kind: "osm",
        currentOsmRef: { type: "node", id: "101" },
        firstSeen: evidence,
        lastVerified: evidence,
      },
    },
    body: "Ask for the house blend.",
    media: [],
    contentHash: "note-hash",
    publishedAt: NOW,
  } as const;
}

async function seededList(repo: DexieRepository): Promise<void> {
  await repo.createList({
    id: "list-1",
    name: "Lisbon Weekend",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.addToList("list-1", { kind: "poi", poi: poi() }, NOW);
}

/** Post-targeted note fixtures: a note now anchors to a place or a post. */
async function _seededPost(repo: DexieRepository, postTitle: string): Promise<void> {
  await repo.createList({
    id: "list-1",
    name: "Notes",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.createPost({
    id: "post-1",
    title: postTitle,
    listId: "list-1",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function serviceFetcher(storage = new MemoryStorage()): {
  fetcher: typeof fetch;
  storage: MemoryStorage;
} {
  const app = createShareApp({ storage });
  return {
    fetcher: async (input, init) =>
      app.request(new URL(String(input), "https://share.test").toString(), init),
    storage,
  };
}

describe("Phase 5 durable publication jobs", () => {
  it("reuses the failed job's idempotency key when the creator retries", async () => {
    const repo = new DexieRepository(`phase5-retry-key-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    const seenKeys: string[] = [];
    let failNext = true;
    const fetcher: typeof fetch = async (input, init) => {
      const key = new Headers(init?.headers).get("idempotency-key");
      if (key) seenKeys.push(key);
      if (failNext) {
        failNext = false;
        return new Response("temporarily unavailable", { status: 503 });
      }
      return service.fetcher(input, init);
    };

    try {
      await seededList(repo);
      await publishList(repo, "list-1", NOW, fetcher);
      const failedJob = await repo.db.publicationOutbox.toCollection().first();
      expect(failedJob).toBeDefined();

      // This is the path used by the visible Retry button.
      await publishList(repo, "list-1", LATER, fetcher);

      expect(new Set(seenKeys)).toEqual(new Set([failedJob?.id]));
      expect((await publicationForList(repo, "list-1"))?.publishedRevision).toBe(1);
    } finally {
      repo.db.close();
    }
  });

  it("never attaches a newer payload to an idempotency key that may already have committed", async () => {
    const repo = new DexieRepository(`phase5-ambiguous-commit-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    const seenKeys: string[] = [];
    let loseFirstResponse = true;
    const fetcher: typeof fetch = async (input, init) => {
      const key = new Headers(init?.headers).get("idempotency-key");
      if (key) seenKeys.push(key);
      const response = await service.fetcher(input, init);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new TypeError("connection lost after the server committed");
      }
      return response;
    };

    try {
      await seededList(repo);
      await publishList(repo, "list-1", NOW, fetcher);
      const first = await service.storage.get("list", "lisbon-weekend");
      if (!first) throw new Error("first public revision missing");

      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "New local place", lat: 38.72, lng: -9.15 } },
        LATER,
      );
      await publishList(repo, "list-1", LATER, fetcher);

      const current = await service.storage.get("list", "lisbon-weekend");
      expect(current?.body).not.toBe(first.body);
      expect(new Set(seenKeys).size).toBe(2);
    } finally {
      repo.db.close();
    }
  });

  it("never lets an older durable job overwrite a newer published revision", async () => {
    const repo = new DexieRepository(`phase5-stale-job-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    try {
      await seededList(repo);
      await publishList(repo, "list-1", NOW, service.fetcher);
      const first = await service.storage.get("list", "lisbon-weekend");
      if (!first) throw new Error("first public revision missing");

      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Newer place", lat: 38.72, lng: -9.15 } },
        LATER,
      );
      await publishList(repo, "list-1", LATER, service.fetcher);
      const publication = await publicationForList(repo, "list-1");
      const newer = await service.storage.get("list", "lisbon-weekend");
      if (!publication || !newer) throw new Error("newer public revision missing");
      expect(newer.body).not.toBe(first.body);

      // Model a delayed/offline job resurfacing after the newer revision won.
      await repo.db.publicationOutbox.put({
        id: "delayed-old-job",
        publicationId: publication.id,
        action: "publish",
        localRevision: (JSON.parse(first.body) as { contentHash: string }).contentHash,
        payload: first.body,
        createdAt: LATEST,
        attempts: 1,
      });
      await runPublicationOutbox(repo, service.fetcher);

      const afterDelayedJob = await service.storage.get("list", "lisbon-weekend");
      expect(afterDelayedJob?.body).toBe(newer.body);
      expect((await publicationForList(repo, "list-1"))?.publishedRevision).toBe(2);
    } finally {
      repo.db.close();
    }
  });

  it("does not clear a newer queued edit when an older in-flight publish completes", async () => {
    const repo = new DexieRepository(`phase5-inflight-edit-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const delayedFetcher: typeof fetch = async (input, init) => {
      signalStarted?.();
      await requestGate;
      return service.fetcher(input, init);
    };

    try {
      await seededList(repo);
      const firstPublish = publishList(repo, "list-1", NOW, delayedFetcher);
      await started;

      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Edited while sending", lat: 38.72, lng: -9.15 } },
        LATER,
      );
      releaseRequest?.();
      await firstPublish;

      const publication = await publicationForList(repo, "list-1");
      expect(publication?.status).toBe("queued");
      expect(publication?.localRevision).not.toBe(publication?.lastPublishedLocalRevision);
      await expect(repo.db.publicationOutbox.count()).resolves.toBe(1);
    } finally {
      releaseRequest?.();
      repo.db.close();
    }
  });

  it("queues the next revision when an already-published list changes", async () => {
    const repo = new DexieRepository(`phase5-local-edit-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    try {
      await seededList(repo);
      await publishList(repo, "list-1", NOW, service.fetcher);
      const before = await publicationForList(repo, "list-1");

      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Offline edit", lat: 38.72, lng: -9.15 } },
        LATER,
      );

      const after = await publicationForList(repo, "list-1");
      expect(after?.status).toBe("queued");
      expect(after?.localRevision).not.toBe(before?.lastPublishedLocalRevision);
      await expect(repo.db.publicationOutbox.count()).resolves.toBe(1);
    } finally {
      repo.db.close();
    }
  });

  it("shows changes pending while a locally edited publication is queued", async () => {
    const repo = new DexieRepository(`phase5-queued-pending-ui-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    let view: ReturnType<typeof render> | undefined;
    try {
      await seededList(repo);
      await publishList(repo, "list-1", NOW, service.fetcher);
      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Pending local edit", lat: 38.72, lng: -9.15 } },
        LATER,
      );
      const publication = await publicationForList(repo, "list-1");
      expect(publication?.status).toBe("queued");
      expect(publication?.localRevision).not.toBe(publication?.lastPublishedLocalRevision);

      view = render(
        createElement(RepoProvider, { repo }, createElement(PublishControls, { listId: "list-1" })),
      );

      expect(await screen.findByTestId("publication-status")).toHaveAttribute(
        "data-status",
        "queued",
      );
      expect(
        await screen.findByText(/changes pending|local changes.*not yet published/i),
      ).toBeInTheDocument();
      expect(screen.getByTestId("publish-update")).toBeInTheDocument();
      expect(screen.getByTestId("unpublish")).toBeInTheDocument();
    } finally {
      view?.unmount();
      repo.db.close();
    }
  });

  it("atomically commits a list edit with its publication-state and outbox changes", async () => {
    const repo = new DexieRepository(`phase5-edit-atomicity-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    let restoreOutboxPut: (() => void) | undefined;
    try {
      await seededList(repo);
      await publishList(repo, "list-1", NOW, service.fetcher);
      const before = await publicationForList(repo, "list-1");

      const outboxPut = vi
        .spyOn(repo.db.publicationOutbox, "put")
        .mockRejectedValueOnce(new Error("simulated IndexedDB quota failure"));
      restoreOutboxPut = () => outboxPut.mockRestore();
      await expect(
        repo.addToList(
          "list-1",
          { kind: "manual", facts: { name: "Must roll back", lat: 38.72, lng: -9.15 } },
          LATER,
        ),
      ).rejects.toThrow(/quota/i);

      await expect(repo.getListBlocks("list-1")).resolves.toHaveLength(1);
      expect(await publicationForList(repo, "list-1")).toEqual(before);
      await expect(repo.db.publicationOutbox.count()).resolves.toBe(0);
    } finally {
      restoreOutboxPut?.();
      repo.db.close();
    }
  });

  it("keeps a publication recoverably failed when its editor credential is missing", async () => {
    const repo = new DexieRepository(`phase5-missing-token-${crypto.randomUUID()}`);
    try {
      await repo.db.publications.put({
        id: "publication-1",
        target: { kind: "list", id: "list-1" },
        slug: "lost-key-guide",
        credentialId: "missing-credential",
        status: "queued",
        localRevision: "local-revision-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.db.publicationOutbox.put({
        id: "publish-job-1",
        publicationId: "publication-1",
        action: "publish",
        localRevision: "local-revision-1",
        payload: JSON.stringify({ v: 1, title: "Lost key", blocks: [], contentHash: "hash" }),
        createdAt: NOW,
        attempts: 0,
      });

      await runPublicationOutbox(repo, async () => {
        throw new Error("a request must not be attempted without the token");
      });

      const publication = await repo.db.publications.get("publication-1");
      expect(publication).toMatchObject({
        status: "failed",
        lastError: expect.stringMatching(/credential|token|key/i),
      });
      await expect(repo.db.publicationOutbox.count()).resolves.toBe(1);
    } finally {
      repo.db.close();
    }
  });

  it("does not let one missing credential starve another publication's outbox", async () => {
    const repo = new DexieRepository(`phase5-missing-token-isolation-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    try {
      await repo.db.publications.put({
        id: "broken-publication",
        target: { kind: "list", id: "broken-list" },
        slug: "broken-guide",
        credentialId: "missing-credential",
        status: "queued",
        localRevision: "broken-local-revision",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.db.publicationOutbox.put({
        id: "broken-job",
        publicationId: "broken-publication",
        action: "publish",
        localRevision: "broken-local-revision",
        payload: JSON.stringify({ v: 1, title: "Broken", blocks: [], contentHash: "broken" }),
        createdAt: NOW,
        attempts: 0,
      });
      await repo.createList({
        id: "healthy-list",
        name: "Healthy guide",
        marker: markerAt(0),
        createdAt: LATER,
        updatedAt: LATER,
      });
      await repo.addToList("healthy-list", { kind: "poi", poi: poi() }, LATER);

      await publishList(repo, "healthy-list", LATER, service.fetcher);

      expect(await service.storage.get("list", "healthy-guide")).toBeDefined();
      expect((await publicationForList(repo, "healthy-list"))?.status).toBe("published");
      expect((await repo.db.publications.get("broken-publication"))?.status).toBe("failed");
    } finally {
      repo.db.close();
    }
  });

  it("surfaces a failed revocation and retries it with the original idempotency key", async () => {
    const repo = new DexieRepository(`phase5-revoke-retry-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    const seenDeleteKeys: string[] = [];
    let failNextDelete = true;
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method === "DELETE") {
        const key = new Headers(init.headers).get("idempotency-key");
        if (key) seenDeleteKeys.push(key);
        if (failNextDelete) {
          failNextDelete = false;
          return new Response("temporarily unavailable", { status: 503 });
        }
      }
      return service.fetcher(input, init);
    };

    try {
      await seededList(repo);
      await publishList(repo, "list-1", NOW, service.fetcher);
      const publication = await publicationForList(repo, "list-1");
      if (!publication) throw new Error("publication fixture missing");

      await revokePublication(repo, publication.id, LATER, fetcher);
      const failedJob = await repo.db.publicationOutbox.toCollection().first();
      if (!failedJob) throw new Error("failed revoke job missing");
      expect.soft((await publicationForList(repo, "list-1"))?.status).toBe("failed");

      await revokePublication(repo, publication.id, LATEST, fetcher);

      expect(new Set(seenDeleteKeys)).toEqual(new Set([failedJob.id]));
      expect((await publicationForList(repo, "list-1"))?.status).toBe("revoked");
      await expect(repo.db.publicationOutbox.count()).resolves.toBe(0);
    } finally {
      repo.db.close();
    }
  });
});
