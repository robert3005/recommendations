/**
 * Preflight disclosure (spec/src/sharing.md §Explicit publish): before
 * anything is sent, the preview shows exactly what leaves — title, places
 * with coordinates, body — and offers the linked-but-unpublished posts and a
 * list post's list. Nothing reaches the service until Publish is confirmed.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { PostPublishControls } from "./PostPublishControls";
import { PublishControls } from "./PublishControls";
import { getHosted, StubRepo } from "./testSupport";

type AnyRepo = Parameters<typeof RepoProvider>[0]["repo"];

const PLACES = [
  { name: "Café Central", lat: 38.7139, lng: -9.1394 },
  { name: "Livraria Antiga", lat: 38.7141, lng: -9.1392 },
];

describe("PublishControls preflight", () => {
  it("disclose title and places+coords, offers the list's unpublished posts, and sends nothing until confirmed", async () => {
    const user = userEvent.setup();
    const repo = new StubRepo();
    const list = repo.seedList("Disclosure Weekend", PLACES);
    repo.seedPost({ kind: "list", listId: list.id }, "Sidebar Draft", "…");

    render(
      <RepoProvider repo={repo as unknown as AnyRepo}>
        <PublishControls listId={list.id} />
      </RepoProvider>,
    );

    await user.click(await screen.findByTestId("publish-list"));
    const dialog = await screen.findByTestId("publish-preflight");
    expect(dialog).toBeInTheDocument();

    // The exact disclosure: title and every place with its coordinates.
    expect(screen.getByTestId("preflight-title")).toHaveTextContent("Disclosure Weekend");
    const rows = screen.getAllByTestId("preflight-place");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Café Central");
    expect(rows[0]).toHaveTextContent("38.7139, -9.1394");
    expect(rows[1]).toHaveTextContent("Livraria Antiga");
    expect(rows[1]).toHaveTextContent("38.7141, -9.1392");

    // The offer names the unpublished post about this list.
    expect(screen.getByTestId("preflight-offer")).toBeInTheDocument();
    expect(screen.getByText(/Sidebar Draft/)).toBeInTheDocument();

    // Nothing has left the device.
    expect(repo.publications).toHaveLength(0);
    expect((await getHosted("lists", "disclosure-weekend")).status).toBe(404);

    await user.click(screen.getByTestId("confirm-publish-list"));
    await waitFor(async () => {
      expect(repo.publications).toHaveLength(1);
    });
    expect((await getHosted("lists", "disclosure-weekend")).status).toBe(200);
    expect(await screen.findByTestId("public-link")).toHaveTextContent("/l/disclosure-weekend");
  });
});

describe("PostPublishControls preflight", () => {
  it("discloses the body, names the unlinked list, and publishes it alongside when the offer is accepted", async () => {
    const user = userEvent.setup();
    const repo = new StubRepo();
    const list = repo.seedList("Alongside Crawl", PLACES);
    const post = repo.seedPost(
      { kind: "list", listId: list.id },
      "Alongside Crawl Guide",
      "The exact words that leave the device.",
    );

    render(
      <RepoProvider repo={repo as unknown as AnyRepo}>
        <PostPublishControls postId={post.id} />
      </RepoProvider>,
    );

    await user.click(await screen.findByTestId("publish-post"));
    await screen.findByTestId("publish-preflight");

    // Body disclosure is the rewritten Markdown source, verbatim.
    expect(screen.getByTestId("preflight-body")).toHaveTextContent(
      "The exact words that leave the device.",
    );
    // The list is named but not linked — and offered for publishing alongside.
    expect(screen.getByTestId("preflight-list-ref")).toHaveTextContent("Alongside Crawl");
    expect(screen.getByTestId("preflight-list-ref")).toHaveTextContent("name only");

    await user.click(screen.getByTestId("preflight-offer"));
    await user.click(screen.getByTestId("confirm-publish-post"));

    await waitFor(() => {
      expect(repo.publications).toHaveLength(2);
    });
    const listPublication = await repo.publicationFor({ kind: "list", id: list.id });
    const postPublication = await repo.publicationFor({ kind: "post", id: post.id });
    expect(listPublication?.revokedAt).toBeUndefined();
    const doc = (await (await getHosted("posts", postPublication?.slug ?? "")).json()) as {
      list?: { url?: string };
    };
    expect(doc.list?.url).toContain(`/l/${listPublication?.slug ?? ""}`);
  });
});
