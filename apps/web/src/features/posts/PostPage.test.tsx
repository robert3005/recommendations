/**
 * The post pages in the pane-and-canvas shell (spec/src/posts.md): reading
 * renders sections and embeds in order with the "From the list" association
 * and publishes the post projection to the canvas; the editor embeds only the
 * post's list members and the place card offers "Embed in post" while an
 * editor is open.
 */
import { markerAt } from "@placemarks/domain";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
  useProjectionStore.setState({
    projection: { kind: "all" },
    postSelectHandler: null,
    sharedSelectHandler: null,
  });
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
      expect(await screen.findByTestId("post-list-link")).toHaveTextContent("Lisbon Weekend");
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

  it("uses the retained exact Google listing even when another external ref comes first", async () => {
    const repo = new DexieRepository(`post-google-ref-${crypto.randomUUID()}`);
    const googleUrl = "https://www.google.com/maps/place/?q=place_id:ChIJExact";
    try {
      const { placeA } = await seed(repo);
      const row = await repo.db.places.get(placeA);
      if (!row) throw new Error("seeded place missing");
      await repo.db.places.put({
        ...row,
        externalRefs: [
          { provider: "web", url: "https://example.com/place", importedAt: NOW },
          { provider: "google-maps", url: googleUrl, importedAt: NOW },
        ],
      });

      render(
        <RepoProvider repo={repo}>
          <PostPage />
        </RepoProvider>,
      );

      expect(await screen.findByTestId("open-google-maps")).toHaveAttribute("href", googleUrl);
    } finally {
      repo.db.close();
    }
  });

  it("observes asynchronously loaded embeds and scrolls/highlights them from a map tap", async () => {
    const repo = new DexieRepository(`post-map-sync-${crypto.randomUUID()}`);
    const observed: Element[] = [];
    let intersectionCallback: IntersectionObserverCallback | undefined;
    const scrollIntoView = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {}
        unobserve() {}
        takeRecords() {
          return [];
        }
        root = null;
        rootMargin = "";
        thresholds = [0.4];
      },
    );
    const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      const { placeA } = await seed(repo);
      render(
        <RepoProvider repo={repo}>
          <PostPage />
        </RepoProvider>,
      );
      const section = await screen.findByTestId("post-section");
      const embed = await screen.findByTestId("post-embed");
      await waitFor(() => expect(observed).toContain(section));
      await waitFor(() => expect(observed).toContain(embed));

      // Prose frames the consecutive embeds it introduces, not just cards.
      act(() => {
        intersectionCallback?.(
          [{ target: section, isIntersecting: true } as unknown as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      await waitFor(() =>
        expect(useProjectionStore.getState().projection).toMatchObject({
          kind: "post",
          focusPlaceIds: [placeA],
        }),
      );

      act(() => {
        intersectionCallback?.(
          [{ target: embed, isIntersecting: true } as unknown as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      await waitFor(() =>
        expect(useProjectionStore.getState().projection).toMatchObject({
          kind: "post",
          focusPlaceIds: [placeA],
        }),
      );

      act(() => useProjectionStore.getState().postSelectHandler?.(placeA));
      expect(scrollIntoView).toHaveBeenCalled();
      expect(embed).toHaveAttribute("data-selected", "true");
    } finally {
      vi.unstubAllGlobals();
      if (previousScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
          configurable: true,
          value: previousScrollIntoView,
        });
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
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
