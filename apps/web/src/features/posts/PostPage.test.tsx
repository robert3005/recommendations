/**
 * The post pages in the pane-and-canvas shell (spec/src/posts.md): reading
 * renders sections and embeds in order with the "From the list" association
 * and publishes the post projection to the canvas; the editor embeds only the
 * post's list members and the place card offers "Embed in post" while an
 * editor is open.
 */
import { markerAt } from "@placemarks/domain";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { useProjectionStore } from "../../state/projection";
import { useUiStore } from "../../state/ui";
import { PostEditorPage } from "./PostEditorPage";
import { PostPage } from "./PostPage";

const NOW = "2026-07-20T09:00:00.000Z";

const navigation = vi.hoisted(() => ({
  params: { postId: "post-1" },
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => navigation.params,
  useNavigate: () => navigation.navigate,
  Link: ({ children, ...props }: { children?: unknown } & Record<string, unknown>) => (
    <a href="#list" data-testid={(props["data-testid"] as string) ?? "router-link"}>
      {children as never}
    </a>
  ),
}));

vi.mock("../publish/PostPublishControls", () => ({ PostPublishControls: () => null }));

async function seed(repo: DexieRepository): Promise<{ placeA: string; placeB: string }> {
  await repo.createList({
    id: "list-1",
    name: "Lisbon Weekend",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const placeA = (
    await repo.addToList(
      "list-1",
      { kind: "manual", facts: { name: "Café Central", lat: 38.7139, lng: -9.1394 } },
      NOW,
    )
  ).place.id;
  const placeB = (
    await repo.addToList(
      "list-1",
      { kind: "manual", facts: { name: "Miradouro", lat: 38.72, lng: -9.13 } },
      NOW,
    )
  ).place.id;
  await repo.createPost({
    id: "post-1",
    title: "A Weekend of Lisbon Coffee",
    listId: "list-1",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const section = await repo.addPostSection("post-1", "Start at the old café.", NOW, "Morning");
  expect(section.content.type).toBe("section");
  await repo.embedPlaceInPost("post-1", placeA, NOW);
  return { placeA, placeB };
}

beforeEach(() => {
  navigation.navigate.mockClear();
  useProjectionStore.setState({ projection: { kind: "all" } });
  useUiStore.setState({ selection: null, embedTargetPostId: null });
});

describe("post reading page", () => {
  it("renders the article and publishes the post projection", async () => {
    const repo = new DexieRepository(`post-page-${crypto.randomUUID()}`);
    try {
      await seed(repo);
      render(
        <RepoProvider repo={repo}>
          <PostPage />
        </RepoProvider>,
      );

      expect(await screen.findByText("A Weekend of Lisbon Coffee")).toBeInTheDocument();
      const section = await screen.findByTestId("post-section");
      expect(section).toHaveTextContent("Morning");
      expect(section).toHaveTextContent("Start at the old café.");
      const embed = await screen.findByTestId("post-embed");
      expect(embed).toHaveTextContent("Café Central");
      // The post page links back to its list (list ↔ posts in both directions).
      expect(screen.getByTestId("post-list-link")).toHaveTextContent("Lisbon Weekend");
      // The route published its projection: the canvas shows the post's embeds.
      expect(useProjectionStore.getState().projection).toMatchObject({
        kind: "post",
        postId: "post-1",
      });
    } finally {
      repo.db.close();
    }
  });

  it("selects and flies bidirectionally from an embed card", async () => {
    const repo = new DexieRepository(`post-select-${crypto.randomUUID()}`);
    try {
      const { placeA } = await seed(repo);
      render(
        <RepoProvider repo={repo}>
          <PostPage />
        </RepoProvider>,
      );
      await userEvent.click(await screen.findByTestId("post-embed-select"));
      expect(useUiStore.getState().selection).toEqual({ kind: "place", placeId: placeA });
      expect(useUiStore.getState().flyTo).toMatchObject({ lat: 38.7139, lng: -9.1394 });
    } finally {
      repo.db.close();
    }
  });
});

describe("post block editor", () => {
  it("offers only un-embedded list members, embeds them, and flags the editor to the card", async () => {
    const repo = new DexieRepository(`post-editor-${crypto.randomUUID()}`);
    try {
      const { placeB } = await seed(repo);
      render(
        <RepoProvider repo={repo}>
          <PostEditorPage />
        </RepoProvider>,
      );

      // The open editor is the card's embed target (spec/src/map-view.md).
      expect(await screen.findByTestId("post-editor")).toBeInTheDocument();
      expect(useUiStore.getState().embedTargetPostId).toBe("post-1");
      // The canvas shows embeds solid with the list dimmed as candidates.
      expect(useProjectionStore.getState().projection).toEqual({
        kind: "post",
        postId: "post-1",
        editing: true,
      });

      const picker = await screen.findByTestId("embed-picker");
      const options = within(picker).getAllByRole("option");
      // Café Central is already embedded — only Miradouro is offered.
      expect(options.map((option) => option.textContent)).toEqual([
        "+ Embed a place…",
        "Miradouro",
      ]);
      await userEvent.selectOptions(picker, placeB);
      await waitFor(() => expect(screen.getAllByTestId("editor-embed")).toHaveLength(2));
    } finally {
      repo.db.close();
    }
  });
});
