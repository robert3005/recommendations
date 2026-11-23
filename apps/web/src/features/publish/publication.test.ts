/**
 * Foreground publish flow against the real share-service protocol (MSW mounts
 * the actual service app — spec/src/sharing.md §The share service): first
 * publish claims a slug and stores the token, update reuses both, 403/410 walk
 * suffixes, unpublish tombstones, republish gets a new slug.
 */
import { describe, expect, it } from "vitest";
import {
  AUTHOR_NAME_KEY,
  currentDocumentHash,
  publishList,
  publishPost,
  republish,
  stalePublications,
  unpublish,
} from "./publication";
import { getHosted, minimalListDoc, putHosted, StubRepo } from "./testSupport";

const PLACES = [
  { name: "Café Central", lat: 38.7139, lng: -9.1394, address: "Rua Example 12" },
  { name: "Tasca do Zé", lat: 38.71, lng: -9.14 },
];

describe("publishList", () => {
  it("first publish claims the title slug and stores a fresh ≥256-bit token", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("First Claim Weekend", PLACES);

    const publication = await publishList(repo, list.id);

    expect(publication.slug).toBe("first-claim-weekend");
    expect(publication.target).toEqual({ kind: "list", id: list.id });
    // 32 random bytes → 43 base64url chars, never sent in a URL or document.
    expect(publication.editorToken?.length ?? 0).toBeGreaterThanOrEqual(43);
    expect(publication.lastPublishedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(publication.publishedAt).toBeDefined();
    expect(publication.revokedAt).toBeUndefined();

    const response = await getHosted("lists", "first-claim-weekend");
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeTruthy();
    const doc = (await response.json()) as {
      title: string;
      places: { name: string; lat: number }[];
    };
    expect(doc.title).toBe("First Claim Weekend");
    expect(doc.places.map((p) => p.name)).toEqual(["Café Central", "Tasca do Zé"]);
    expect(JSON.stringify(doc)).not.toContain(publication.editorToken);
  });

  it("update reuses the slug and token and refreshes the published hash", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("Update In Place", PLACES);
    const first = await publishList(repo, list.id);

    const renamed = { ...list, name: "Update In Place, Revised" };
    repo.lists.set(list.id, renamed);
    expect(await currentDocumentHash(repo, { kind: "list", id: list.id })).not.toBe(
      first.lastPublishedHash,
    );

    const second = await publishList(repo, list.id);

    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);
    expect(second.editorToken).toBe(first.editorToken);
    expect(second.lastPublishedHash).not.toBe(first.lastPublishedHash);
    expect(await currentDocumentHash(repo, { kind: "list", id: list.id })).toBe(
      second.lastPublishedHash,
    );

    const doc = (await (await getHosted("lists", first.slug)).json()) as { title: string };
    // The public page changed only on explicit update — and to the new title.
    expect(doc.title).toBe("Update In Place, Revised");
    expect(repo.publications).toHaveLength(1);
  });

  it("walks -2… suffixes when the base slug is owned by another token", async () => {
    const rival = await putHosted(
      "lists",
      "foreign-owner-walk",
      minimalListDoc("Rival"),
      "rival-token-owning-the-base-slug-0000000000",
    );
    expect(rival.status).toBe(201);

    const repo = new StubRepo();
    const list = repo.seedList("Foreign Owner Walk", PLACES);
    const publication = await publishList(repo, list.id);

    expect(publication.slug).toBe("foreign-owner-walk-2");
    expect((await getHosted("lists", "foreign-owner-walk-2")).status).toBe(200);
    // The rival's document is untouched.
    const base = (await (await getHosted("lists", "foreign-owner-walk")).json()) as {
      title: string;
    };
    expect(base.title).toBe("Rival");
  });

  it("unpublish tombstones the slug; republish claims a new one under a new token", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("Tombstone Then Return", PLACES);
    const first = await publishList(repo, list.id);

    await unpublish(repo, first);
    const revoked = await repo.publicationFor({ kind: "list", id: list.id });
    expect(revoked?.revokedAt).toBeDefined();
    expect((await getHosted("lists", first.slug)).status).toBe(410);

    // A tombstoned slug is never reused: the walk skips it on 410.
    const second = await publishList(repo, list.id);
    expect(second.id).not.toBe(first.id);
    expect(second.slug).toBe(`${first.slug}-2`);
    expect(second.editorToken).not.toBe(first.editorToken);
    expect(second.revokedAt).toBeUndefined();
    expect((await getHosted("lists", second.slug)).status).toBe(200);
    expect((await getHosted("lists", first.slug)).status).toBe(410);
    // The tombstone row persists locally beside the live one.
    expect(repo.publications).toHaveLength(2);
  });
});

describe("publishPost", () => {
  it("a published list post carries the list's title and live URL, and the list shows unpublished changes", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("Backlink Crawl", PLACES);
    const post = repo.seedPost({ kind: "list", listId: list.id }, "Backlink Crawl Notes", "Words.");

    const listPublication = await publishList(repo, list.id);
    await publishPost(repo, post.id);

    const postPublication = await repo.publicationFor({ kind: "post", id: post.id });
    const doc = (await (await getHosted("posts", postPublication?.slug ?? "")).json()) as {
      list?: { title: string; url?: string };
      places: unknown[];
    };
    expect(doc.list?.title).toBe("Backlink Crawl");
    expect(doc.list?.url).toContain(`/l/${listPublication.slug}`);
    expect(doc.list?.url).toMatch(/^https:\/\//);
    // A list post projects its list's members.
    expect(doc.places).toHaveLength(2);

    // The list's projection now links this post — its public page lags until
    // its owner presses Publish update, and the hash comparison says so.
    expect(await currentDocumentHash(repo, { kind: "list", id: list.id })).not.toBe(
      listPublication.lastPublishedHash,
    );
  });

  it("a place post projects its one place and carries no list back-link", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("One Place Holder", PLACES);
    const entry = repo.entries.find((e) => e.listId === list.id);
    const post = repo.seedPost(
      { kind: "place", placeId: entry?.placeId ?? "" },
      "Just The One Cafe",
      "A single place.",
    );

    await publishPost(repo, post.id);

    const publication = await repo.publicationFor({ kind: "post", id: post.id });
    const doc = (await (await getHosted("posts", publication?.slug ?? "")).json()) as {
      list?: unknown;
      places: { name: string }[];
    };
    expect(doc.list).toBeUndefined();
    expect(doc.places.map((p) => p.name)).toEqual(["Café Central"]);
  });
});

describe("live, versioned pages", () => {
  it("stamps each publish with the next version without changing the content hash", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("Versioned Weekend", PLACES);

    const first = await publishList(repo, list.id);
    expect(first.version).toBe(1);
    const hosted = (await (await getHosted("lists", first.slug)).json()) as {
      version?: number;
      updatedAt?: string;
    };
    expect(hosted.version).toBe(1);
    expect(hosted.updatedAt).toBeDefined();
    // The stamp is on the wire copy only: the unchanged list is not "behind".
    expect(await currentDocumentHash(repo, { kind: "list", id: list.id })).toBe(
      first.lastPublishedHash,
    );
    expect(await stalePublications(repo)).toEqual([]);

    const second = await publishList(repo, list.id);
    expect(second.version).toBe(2);
    expect(second.lastPublishedHash).toBe(first.lastPublishedHash);
  });

  it("lists a changed live page as behind, and republish brings it up to date", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("Live Weekend", PLACES);
    const first = await publishList(repo, list.id);

    repo.lists.set(list.id, { ...list, description: "Now with an intro." });
    const stale = await stalePublications(repo);
    expect(stale.map((s) => s.publication.id)).toEqual([first.id]);

    const updated = await republish(repo, first);
    expect(updated.version).toBe(2);
    expect(await stalePublications(repo)).toEqual([]);
    const hosted = (await (await getHosted("lists", first.slug)).json()) as {
      description?: string;
    };
    expect(hosted.description).toBe("Now with an intro.");
  });

  it("never lists a page switched to manual, or one this device cannot update", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("Manual Weekend", PLACES);
    const publication = await publishList(repo, list.id);
    repo.lists.set(list.id, { ...list, name: "Manual Weekend, edited" });

    const row = repo.publications.find((p) => p.id === publication.id);
    if (!row) throw new Error("no row");
    row.live = false;
    expect(await stalePublications(repo)).toEqual([]);

    row.live = true;
    delete row.editorToken;
    expect(await stalePublications(repo)).toEqual([]);
  });
});

describe("the curator's voice", () => {
  it("publishes the intro, the name, and each place's note, tags and rating", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("Voiced Weekend", PLACES);
    repo.lists.set(list.id, { ...list, description: "Where I take visitors." });
    repo.settings.set(AUTHOR_NAME_KEY, "  Robert ");
    const [first] = [...repo.places.values()];
    if (!first) throw new Error("no place");
    repo.places.set(first.id, { ...first, note: "Ask for the bica.", tags: ["coffee"], rating: 3 });

    const publication = await publishList(repo, list.id);
    const doc = (await (await getHosted("lists", publication.slug)).json()) as {
      author?: string;
      description?: string;
      places: { note?: string; tags?: string[]; rating?: number }[];
    };
    expect(doc.author).toBe("Robert");
    expect(doc.description).toBe("Where I take visitors.");
    expect(doc.places[0]).toMatchObject({ note: "Ask for the bica.", tags: ["coffee"], rating: 3 });
  });

  it("a list that opted out publishes no notes, tags or ratings", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("Quiet Weekend", PLACES);
    repo.lists.set(list.id, { ...list, shareNotes: false });
    const [first] = [...repo.places.values()];
    if (!first) throw new Error("no place");
    repo.places.set(first.id, { ...first, note: "Private.", tags: ["mine"], rating: 2 });

    const publication = await publishList(repo, list.id);
    const text = await (await getHosted("lists", publication.slug)).text();
    expect(text).not.toContain("Private.");
    expect(text).not.toContain("mine");
    expect(text).not.toContain("rating");
  });
});
