/** Focused regressions for the Phase 5 client publication contract. */
import { markerAt, type Note, type ResolvedPoi } from "@placemarks/domain";
import { createShareApp, MemoryStorage } from "@placemarks/share-service";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { NoteViewerPage } from "../share/NoteViewerPage";
import { NotePublishButton } from "./NotePublishButton";
import { PublishControls } from "./PublishControls";
import {
  newEditorToken,
  publicationForList,
  publicationForNote,
  publishList,
  publishNote,
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

function sharedOsmNoteDocument() {
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
async function seededPost(repo: DexieRepository, postTitle: string): Promise<void> {
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
        mode: "hosted",
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
        mode: "hosted",
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

describe("Phase 5 standalone note publication", () => {
  it("publishes a place note with its durable OSM place anchor", async () => {
    const repo = new DexieRepository(`phase5-note-context-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    try {
      await seededList(repo);
      const place = (await repo.listPlaces())[0]?.place;
      if (!place) throw new Error("place fixture missing");
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        title: "Field notes",
        body: "Ask for the house blend.",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);

      await publishNote(repo, note, "Café Central", NOW, service.fetcher);
      const stored = await service.storage.get("note", "field-notes");
      if (!stored) throw new Error("published note missing");
      const document = JSON.parse(stored.body) as {
        context: { kind: string; place?: { kind: string; currentOsmRef?: unknown } };
      };

      expect(document.context).toMatchObject({
        kind: "place",
        place: {
          kind: "osm",
          currentOsmRef: { type: "node", id: "101" },
        },
      });
    } finally {
      repo.db.close();
    }
  });

  it("keeps a standalone note document's slug aligned after collision fallback", async () => {
    const repo = new DexieRepository(`phase5-note-slug-collision-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    try {
      const claimed = await service.fetcher("https://share.test/s/notes", {
        method: "POST",
        headers: {
          authorization: `Bearer ${newEditorToken()}`,
          "idempotency-key": "existing-note-job",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          desiredSlug: "field-notes",
          document: sharedOsmNoteDocument(),
        }),
      });
      expect(claimed.status).toBe(201);

      await seededPost(repo, "Notes post");
      const note: Note = {
        id: "note-1",
        target: { kind: "post", postId: "post-1" },
        title: "Field notes",
        body: "A different note.",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);

      const publication = await publishNote(repo, note, "Notes post", NOW, service.fetcher);
      if (!publication?.slug) throw new Error("note publication missing");
      const stored = await service.storage.get("note", publication.slug);
      if (!stored) throw new Error("collision-fallback note missing");

      expect(publication.slug).toBe("field-notes-2");
      expect((JSON.parse(stored.body) as { slug: string }).slug).toBe(publication.slug);
    } finally {
      repo.db.close();
    }
  });

  it("queues standalone-page revocation when a published note stops being shareable", async () => {
    const repo = new DexieRepository(`phase5-note-revoke-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    try {
      const note: Note = {
        id: "note-1",
        target: { kind: "post", postId: "post-1" },
        title: "Private later",
        body: "This starts public.",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await seededPost(repo, "Notes post");
      await repo.createNote(note);
      await publishNote(repo, note, "Notes post", NOW, service.fetcher);

      await repo.updateNote({ ...note, shareable: false, updatedAt: LATER });

      const publication = await publicationForNote(repo, note.id);
      expect(publication?.status).toBe("revoking");
      const jobs = await repo.db.publicationOutbox.toArray();
      expect(jobs).toContainEqual(
        expect.objectContaining({ publicationId: publication?.id, action: "revoke" }),
      );
    } finally {
      repo.db.close();
    }
  });

  it("queues both affected hosted projections when a published place note is edited", async () => {
    const repo = new DexieRepository(`phase5-note-edit-dirty-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    try {
      await seededList(repo);
      const place = (await repo.listPlaces())[0]?.place;
      if (!place) throw new Error("place fixture missing");
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        title: "Field notes",
        body: "Original public text.",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);
      await publishList(repo, "list-1", NOW, service.fetcher);
      await publishNote(repo, note, "Café Central", NOW, service.fetcher);
      const listPublication = await publicationForList(repo, "list-1");
      const notePublication = await publicationForNote(repo, note.id);
      if (!listPublication || !notePublication) throw new Error("publication fixture missing");

      await repo.updateNote({
        ...note,
        body: "Edited public text.",
        updatedAt: LATER,
      });

      expect((await publicationForList(repo, "list-1"))?.status).toBe("queued");
      expect((await publicationForNote(repo, note.id))?.status).toBe("queued");
      const jobs = await repo.db.publicationOutbox.toArray();
      expect(jobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ publicationId: listPublication.id, action: "publish" }),
          expect.objectContaining({ publicationId: notePublication.id, action: "publish" }),
        ]),
      );
    } finally {
      repo.db.close();
    }
  });

  it("updates a hosted guide as well as revoking the page when its place note becomes private", async () => {
    const repo = new DexieRepository(`phase5-note-private-guide-${crypto.randomUUID()}`);
    const service = serviceFetcher();
    try {
      await seededList(repo);
      const place = (await repo.listPlaces())[0]?.place;
      if (!place) throw new Error("place fixture missing");
      const note: Note = {
        id: "note-1",
        target: { kind: "place", placeId: place.id },
        title: "Field notes",
        body: "This starts in both public projections.",
        mediaIds: [],
        shareable: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repo.createNote(note);
      await publishList(repo, "list-1", NOW, service.fetcher);
      await publishNote(repo, note, "Café Central", NOW, service.fetcher);
      const listPublication = await publicationForList(repo, "list-1");
      const notePublication = await publicationForNote(repo, note.id);
      if (!listPublication || !notePublication) throw new Error("publication fixture missing");

      await repo.updateNote({ ...note, shareable: false, updatedAt: LATER });

      expect((await publicationForList(repo, "list-1"))?.status).toBe("queued");
      expect((await publicationForNote(repo, note.id))?.status).toBe("revoking");
      const jobs = await repo.db.publicationOutbox.toArray();
      expect(jobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ publicationId: listPublication.id, action: "publish" }),
          expect.objectContaining({ publicationId: notePublication.id, action: "revoke" }),
        ]),
      );
    } finally {
      repo.db.close();
    }
  });

  it("offers update and unpublish as separate actions for an edited published note", async () => {
    const repo = new DexieRepository(`phase5-note-update-ui-${crypto.randomUUID()}`);
    const note: Note = {
      id: "note-1",
      target: { kind: "post", postId: "post-1" },
      title: "Edited field notes",
      body: "The creator changed this after publishing.",
      mediaIds: [],
      shareable: true,
      createdAt: NOW,
      updatedAt: LATER,
    };
    let view: ReturnType<typeof render> | undefined;

    try {
      await seededPost(repo, "Notes post");
      await repo.createNote(note);
      await repo.db.publications.put({
        id: "publication-1",
        target: { kind: "note", id: note.id },
        mode: "hosted",
        slug: "edited-field-notes",
        credentialId: "credential-1",
        status: "published",
        localRevision: NOW,
        lastPublishedLocalRevision: NOW,
        publishedRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });

      view = render(
        createElement(RepoProvider, { repo }, createElement(NotePublishButton, { note })),
      );

      await screen.findByTestId("note-page-link");
      expect(
        screen.getByRole("button", { name: /update page|publish changes/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /unpublish page/i })).toBeInTheDocument();
    } finally {
      view?.unmount();
      repo.db.close();
    }
  });

  it("keeps the last public note link and recovery controls visible after an update fails", async () => {
    const repo = new DexieRepository(`phase5-note-failed-ui-${crypto.randomUUID()}`);
    const note: Note = {
      id: "note-1",
      target: { kind: "post", postId: "post-1" },
      title: "Field notes",
      body: "A local edit failed to publish.",
      mediaIds: [],
      shareable: true,
      createdAt: NOW,
      updatedAt: LATER,
    };
    let view: ReturnType<typeof render> | undefined;

    try {
      await seededPost(repo, "Notes post");
      await repo.createNote(note);
      await repo.db.publications.put({
        id: "publication-1",
        target: { kind: "note", id: note.id },
        mode: "hosted",
        slug: "field-notes",
        credentialId: "credential-1",
        status: "failed",
        localRevision: LATER,
        lastPublishedLocalRevision: NOW,
        publishedRevision: 1,
        lastError: "update failed (503)",
        createdAt: NOW,
        updatedAt: LATER,
      });

      view = render(
        createElement(RepoProvider, { repo }, createElement(NotePublishButton, { note })),
      );

      await screen.findByTestId("note-page-link");
      expect(screen.getByText(/update failed|failed/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry|update/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /unpublish/i })).toBeInTheDocument();
    } finally {
      view?.unmount();
      repo.db.close();
    }
  });

  it("renders and live-resolves a place note from timestamped OSM fallback evidence", async () => {
    phase5Viewer.resolveExact.mockReset();
    phase5Viewer.searchNearby.mockClear();
    phase5Viewer.resolveExact.mockImplementation(() => new Promise(() => {}));
    const document = sharedOsmNoteDocument();
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(document), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let view: ReturnType<typeof render> | undefined;

    try {
      view = render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(NoteViewerPage)),
      );

      await screen.findByTestId("shared-note");
      expect(screen.getByText("Copied old café")).toBeInTheDocument();
      expect(screen.getByText("Copied old address")).toBeInTheDocument();
      expect(screen.getByText(/showing saved facts.*observed 2020-01-02/i)).toBeInTheDocument();
      expect(screen.getByText(/© OpenStreetMap contributors/i)).toBeInTheDocument();
      await waitFor(() => {
        expect(phase5Viewer.resolveExact).toHaveBeenCalledWith({ type: "node", id: "101" });
      });
    } finally {
      view?.unmount();
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes a confirmed missing OSM element from a pending/offline fallback", async () => {
    phase5Viewer.resolveExact.mockReset();
    phase5Viewer.searchNearby.mockReset();
    phase5Viewer.resolveExact.mockResolvedValue({ type: "gone" });
    phase5Viewer.searchNearby.mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(sharedOsmNoteDocument()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let view: ReturnType<typeof render> | undefined;

    try {
      view = render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(NoteViewerPage)),
      );

      expect(
        await screen.findByText(/no longer found on OpenStreetMap.*showing saved facts/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/observed 2020-01-02/i)).toBeInTheDocument();
    } finally {
      view?.unmount();
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });

  it("labels a manual place context as unlinked without making an OSM attribution claim", async () => {
    phase5Viewer.resolveExact.mockReset();
    phase5Viewer.searchNearby.mockClear();
    const document = {
      v: 1,
      slug: "field-notes",
      title: "Manual-place note",
      context: {
        kind: "place",
        place: {
          kind: "manual",
          name: "Owner-added viewpoint",
          category: "viewpoint",
          lat: 38.7139,
          lng: -9.1394,
        },
      },
      body: "Bring water.",
      media: [],
      contentHash: "manual-note-hash",
      publishedAt: NOW,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(document), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let view: ReturnType<typeof render> | undefined;

    try {
      view = render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(NoteViewerPage)),
      );

      await screen.findByTestId("shared-note");
      expect(screen.getByText("Owner-added viewpoint")).toBeInTheDocument();
      expect.soft(screen.queryByText(/not linked to OSM|unlinked/i)).toBeInTheDocument();
      expect.soft(screen.queryByText(/© OpenStreetMap contributors/i)).not.toBeInTheDocument();
      expect.soft(phase5Viewer.resolveExact).not.toHaveBeenCalled();
    } finally {
      view?.unmount();
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });
});
