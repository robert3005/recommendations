/**
 * Post publication (spec/src/posts.md §Publishing): a post page claims its
 * slug under `/s/posts` with a `kind: "post"` document that names its list;
 * the shared document carries the list's public slug only once the list page
 * has actually published; and a pre-pivot guide publication migrated onto a
 * post (channel "lists") keeps draining against `/s/lists` under its original
 * slug (spec/src/sharing.md §Share service).
 *
 * These tests inject a fetcher stub (the publication functions accept one)
 * so they stay independent of the MSW share-service mock.
 */
import { markerAt } from "@placemarks/domain";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { publicationChannel, publicationForPost, publicListSlug, publishPost } from "./publication";

const NOW = "2026-07-19T16:00:00.000Z";
const LATER = "2026-07-19T17:00:00.000Z";

interface RecordedRequest {
  method: string;
  url: string;
  ifMatch: string | null;
  body?: unknown;
}

/**
 * A share-service stand-in: acks slug claims (POST → 201, echoing the desired
 * slug) and conditional updates (PUT → 200, bumping the revision), recording
 * every request it sees.
 */
function stubService(): { fetcher: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let revision = 1;
  const fetcher: typeof fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    requests.push({
      method,
      url: String(input),
      ifMatch: new Headers(init?.headers).get("if-match"),
      body,
    });
    if (method === "POST") {
      const { desiredSlug } = body as { desiredSlug: string };
      return Response.json({ slug: desiredSlug, revision: revision++ }, { status: 201 });
    }
    if (method === "PUT") {
      const slug = String(input).split("/").pop() ?? "";
      return Response.json({ slug, revision: ++revision }, { status: 200 });
    }
    return new Response("unexpected request", { status: 500 });
  };
  return { fetcher, requests };
}

/** A list with one member place and a post editorialising it. */
async function seeded(repo: DexieRepository): Promise<void> {
  await repo.createList({
    id: "list-1",
    name: "Lisbon Weekend",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const place = (
    await repo.addToList(
      "list-1",
      { kind: "manual", facts: { name: "Café Central", lat: 38.7139, lng: -9.1394 } },
      NOW,
    )
  ).place;
  await repo.createPost({
    id: "post-1",
    title: "A Weekend of Lisbon Coffee",
    listId: "list-1",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.embedPlaceInPost("post-1", place.id, NOW);
}

describe("hosted post publication", () => {
  it('claims the slug under /s/posts with a kind "post" document naming its list', async () => {
    const repo = new DexieRepository(`post-publish-${crypto.randomUUID()}`);
    const { fetcher, requests } = stubService();
    try {
      await seeded(repo);

      const publication = await publishPost(repo, "post-1", NOW, fetcher);

      expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /s/posts"]);
      const body = requests[0]?.body as {
        desiredSlug: string;
        document: { kind: string; title: string; list: unknown; blocks: unknown[] };
      };
      expect(body.desiredSlug).toBe("a-weekend-of-lisbon-coffee");
      expect(body.document.kind).toBe("post");
      expect(body.document.title).toBe("A Weekend of Lisbon Coffee");
      // The list has no public page yet — its title travels, no slug.
      expect(body.document.list).toEqual({ title: "Lisbon Weekend" });
      expect(publication).toMatchObject({
        target: { kind: "post", id: "post-1" },
        channel: "posts",
        status: "published",
        slug: "a-weekend-of-lisbon-coffee",
        publishedRevision: 1,
      });
      if (!publication) throw new Error("post publication missing");
      expect(publicationChannel(publication)).toBe("posts");
      expect(await repo.db.publicationOutbox.count()).toBe(0);
    } finally {
      repo.db.close();
    }
  });

  it("carries the list's public slug only once the list page actually published", async () => {
    const repo = new DexieRepository(`post-list-slug-${crypto.randomUUID()}`);
    const { fetcher, requests } = stubService();
    try {
      await seeded(repo);
      const listPublication = {
        id: "publication-list",
        target: { kind: "list" as const, id: "list-1" },
        mode: "hosted" as const,
        slug: "lisbon-weekend",
        credentialId: "credential-list",
        status: "queued" as const,
        localRevision: "list-v1",
        createdAt: NOW,
        updatedAt: NOW,
      };
      // Queued only — the slug is desired, not yet claimed publicly.
      await repo.db.publications.put(listPublication);
      expect(await publicListSlug(repo, "list-1")).toBeUndefined();

      const first = await publishPost(repo, "post-1", NOW, fetcher);
      expect(first?.status).toBe("published");
      const firstRequestBody = requests[0]?.body as { document: { list: unknown } } | undefined;
      const firstDocument = firstRequestBody?.document;
      expect(firstDocument?.list).toEqual({ title: "Lisbon Weekend" });

      // The list page lands: publishedRevision is the proof of a real claim.
      await repo.db.publications.put({
        ...listPublication,
        status: "published",
        publishedRevision: 1,
        lastPublishedLocalRevision: "list-v1",
      });
      expect(await publicListSlug(repo, "list-1")).toBe("lisbon-weekend");

      const second = await publishPost(repo, "post-1", LATER, fetcher);
      expect(second?.status).toBe("published");
      const update = requests.at(-1);
      expect(`${update?.method ?? ""} ${update?.url ?? ""}`).toBe(
        "PUT /s/posts/a-weekend-of-lisbon-coffee",
      );
      const updateBody = update?.body as { document: { list: unknown } } | undefined;
      expect(updateBody?.document.list).toEqual({
        title: "Lisbon Weekend",
        slug: "lisbon-weekend",
      });

      // A revoking list page drops out immediately — no dangling public link.
      await repo.db.publications.put({
        ...listPublication,
        status: "revoking",
        publishedRevision: 1,
      });
      expect(await publicListSlug(repo, "list-1")).toBeUndefined();
    } finally {
      repo.db.close();
    }
  });

  it("drains a migrated pre-pivot publication against /s/lists even though it targets a post", async () => {
    const repo = new DexieRepository(`post-migrated-channel-${crypto.randomUUID()}`);
    const { fetcher, requests } = stubService();
    try {
      await seeded(repo);
      // A pre-pivot guide publication retargeted onto the post by the Dexie v7
      // upgrade: target.kind "post", channel "lists", the original guide slug
      // and server revision (spec/src/sharing.md §Share service).
      await repo.db.credentials.put({
        id: "credential-legacy",
        token: "a".repeat(43),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await repo.db.publications.put({
        id: "publication-legacy",
        target: { kind: "post", id: "post-1" },
        mode: "hosted",
        channel: "lists",
        slug: "lisbon-weekend",
        credentialId: "credential-legacy",
        status: "queued",
        localRevision: "pre-pivot-revision",
        lastPublishedLocalRevision: "pre-pivot-revision",
        publishedRevision: 3,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const publication = await publishPost(repo, "post-1", LATER, fetcher);

      // The update went to the original /s/lists slug — never /s/posts — under
      // the migrated server revision.
      expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["PUT /s/lists/lisbon-weekend"]);
      expect(requests[0]?.ifMatch).toBe('"3"');
      expect(publication).toMatchObject({
        id: "publication-legacy",
        target: { kind: "post", id: "post-1" },
        channel: "lists",
        status: "published",
        slug: "lisbon-weekend",
      });
      const persisted = await publicationForPost(repo, "post-1");
      expect(persisted && publicationChannel(persisted)).toBe("lists");
    } finally {
      repo.db.close();
    }
  });
});
