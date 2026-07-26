/**
 * Publish-time link rewrite, end to end (spec/src/sharing.md §Publish-time
 * link rewrite): published bodies never contain place:/post: protocols —
 * in-projection mentions become #place-<id> fragments, published cross-post
 * links become public URLs, and everything else unwraps to plain text. The
 * preflight offers exactly the linked-but-unpublished posts and the list.
 */
import { describe, expect, it } from "vitest";
import { postPreflight, publishPost } from "./publication";
import { getHosted, StubRepo } from "./testSupport";

async function hostedPostBody(repo: StubRepo, postId: string): Promise<string> {
  const publication = await repo.publicationFor({ kind: "post", id: postId });
  const response = await getHosted("posts", publication?.slug ?? "");
  expect(response.status).toBe(200);
  return ((await response.json()) as { body: string }).body;
}

describe("publish-time link rewrite", () => {
  it("rewrites mentions and post links; offers list and unpublished linked posts alongside", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("Rewrite Food Crawl", [
      { id: "place-ramiro", name: "Ramiro", lat: 38.7203, lng: -9.1355 },
      { id: "place-zeda", name: "Zé da Mouraria", lat: 38.7189, lng: -9.1332 },
    ]);
    // Published before the main post — its link must become a public URL.
    const written = repo.seedPost(
      { kind: "place", placeId: "place-ramiro" },
      "Ramiro Write-Up",
      "Go.",
    );
    await publishPost(repo, written.id);
    // Exists but unpublished — offered in the preflight, unwrapped if declined.
    const draft = repo.seedPost({ kind: "list", listId: list.id }, "The Long Version", "Later.");

    const main = repo.seedPost(
      { kind: "list", listId: list.id },
      "Rewrite Crawl Guide",
      [
        "Start at [Ramiro](place:place-ramiro), skip [the closed one](place:place-gone).",
        "Read [my write-up](post:" +
          written.id +
          "), then [the long version](post:" +
          draft.id +
          "),",
        "and ignore [a dangling link](post:post-never).",
      ].join("\n"),
    );

    const preflight = await postPreflight(repo, main.id);
    expect(preflight?.listOffer).toEqual({ listId: list.id, title: "Rewrite Food Crawl" });
    // The published write-up and the dangling id are NOT offered; the draft is.
    expect(preflight?.unpublishedLinkedPosts).toEqual([
      { id: draft.id, title: "The Long Version" },
    ]);

    await publishPost(repo, main.id, {
      publishListAlongside: true,
      alsoPublishPostIds: [draft.id],
    });

    const body = await hostedPostBody(repo, main.id);
    const writtenSlug = (await repo.publicationFor({ kind: "post", id: written.id }))?.slug;
    const draftSlug = (await repo.publicationFor({ kind: "post", id: draft.id }))?.slug;

    // In-projection mention → fragment; out-of-projection mention → plain text.
    expect(body).toContain("[Ramiro](#place-place-ramiro)");
    expect(body).toContain("skip the closed one.");
    // Published targets → their public URLs; dangling → plain text.
    expect(body).toContain(`[my write-up](https://localhost:3000/p/${writtenSlug ?? ""})`);
    expect(body).toContain(`[the long version](https://localhost:3000/p/${draftSlug ?? ""})`);
    expect(body).toContain("ignore a dangling link.");
    // No custom protocol survives publishing.
    expect(body).not.toContain("place:");
    expect(body).not.toContain("post:");

    // The list, published alongside, links its published posts — the two list
    // posts, not the place post — and the post links the list back.
    const listPublication = await repo.publicationFor({ kind: "list", id: list.id });
    const listDoc = (await (await getHosted("lists", listPublication?.slug ?? "")).json()) as {
      posts?: { title: string; url: string }[];
    };
    expect(listDoc.posts?.map((p) => p.title).sort()).toEqual([
      "Rewrite Crawl Guide",
      "The Long Version",
    ]);
    const mainSlug = (await repo.publicationFor({ kind: "post", id: main.id }))?.slug;
    expect(listDoc.posts?.map((p) => p.url)).toContain(
      `https://localhost:3000/p/${mainSlug ?? ""}`,
    );

    const mainDoc = (await (await getHosted("posts", mainSlug ?? "")).json()) as {
      list?: { title: string; url?: string };
    };
    expect(mainDoc.list?.url).toBe(`https://localhost:3000/l/${listPublication?.slug ?? ""}`);
  });

  it("declined offers leave links as plain text — soft everywhere", async () => {
    const repo = new StubRepo();
    const list = repo.seedList("Declined Offers Walk", [
      { id: "place-a", name: "Stop A", lat: 41.15, lng: -8.61 },
    ]);
    const draft = repo.seedPost({ kind: "list", listId: list.id }, "Unpublished Aside", "…");
    const main = repo.seedPost(
      { kind: "list", listId: list.id },
      "Declined Offers Guide",
      `See [the aside](post:${draft.id}) near [Stop A](place:place-a).`,
    );

    await publishPost(repo, main.id); // no offers accepted

    const body = await hostedPostBody(repo, main.id);
    expect(body).toBe("See the aside near [Stop A](#place-place-a).");
    // Neither the draft nor the list gained a publication.
    expect(await repo.publicationFor({ kind: "post", id: draft.id })).toBeUndefined();
    expect(await repo.publicationFor({ kind: "list", id: list.id })).toBeUndefined();
  });
});
