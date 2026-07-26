/**
 * The post pages (spec/src/posts.md): the reading view renders the sanitised
 * article with soft place:/post: links, projects the post's places, and syncs
 * mention↔pin selection both ways; the editor is a title field plus one
 * Markdown textarea whose palette is the map (pin tap → mention at cursor),
 * with an Insert-post-link picker and an in-place preview.
 */
import type { List, Place, Post } from "@placemarks/domain";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { PostEditorPage } from "./PostEditorPage";
import { PostPage } from "./PostPage";

const NOW = "2026-07-26T09:00:00.000Z";

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

const canvas = vi.hoisted(() => ({ projections: [] as unknown[] }));
const selection = vi.hoisted(() => ({ focusPlace: vi.fn() }));
vi.mock("../../state/projection", () => ({
  useCanvasProjection: (projection: unknown) => {
    canvas.projections.push(projection);
  },
  useSelectionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ focusPlace: selection.focusPlace }),
}));

// The W5b contract (impl brief): { register(onPinTap): unregister }.
const bridge = vi.hoisted(() => ({ handler: null as ((placeId: string) => void) | null }));
vi.mock("../../state/editorBridge", () => ({
  editorBridge: {
    register: (fn: (placeId: string) => void) => {
      bridge.handler = fn;
      return () => {
        if (bridge.handler === fn) bridge.handler = null;
      };
    },
  },
}));

vi.mock("../publish/PublishControls", () => ({ PublishControls: () => null }));

const placeA: Place = {
  id: "place-a",
  name: "Café Central",
  lat: 38.7139,
  lng: -9.1394,
  origin: "search",
  createdAt: NOW,
  updatedAt: NOW,
};
const placeB: Place = {
  id: "place-b",
  name: "Miradouro",
  lat: 38.72,
  lng: -9.13,
  origin: "search",
  createdAt: NOW,
  updatedAt: NOW,
};
const lisbonList: List = {
  id: "list-1",
  name: "Lisbon Weekend",
  marker: { shape: "circle", color: "#F97316" },
  createdAt: NOW,
  updatedAt: NOW,
};

const READING_BODY = [
  "Start at [Café Central](place:place-a), then [Elsewhere](place:place-z).",
  "",
  "Read [the deep dive](post:post-2) or [gone](post:post-9).",
].join("\n");

function fixturePosts(): Post[] {
  return [
    {
      id: "post-1",
      target: { kind: "list", listId: "list-1" },
      title: "A Weekend of Lisbon Coffee",
      body: READING_BODY,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "post-2",
      target: { kind: "place", placeId: "place-a" },
      title: "Café Central deep dive",
      body: "All about the café.",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "post-3",
      target: { kind: "place", placeId: "place-b" },
      title: "Miradouro at dusk",
      body: "",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      // A place post about a place that is NOT on list-1.
      id: "post-4",
      target: { kind: "place", placeId: "place-w" },
      title: "Another guide",
      body: "",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
}

interface Fixture {
  posts: Post[];
  lists: List[];
  places: Place[];
  members: Record<string, string[]>;
}

function fakeRepo(fx: Fixture) {
  const placeFor = (placeId: string): Place => {
    const place = fx.places.find((p) => p.id === placeId);
    if (!place) throw new Error(`fixture place missing: ${placeId}`);
    return place;
  };
  return {
    getPost: vi.fn(async (id: string) => fx.posts.find((p) => p.id === id)),
    getList: vi.fn(async (id: string) => fx.lists.find((l) => l.id === id)),
    getPlace: vi.fn(async (id: string) => fx.places.find((p) => p.id === id)),
    entriesOf: vi.fn(async (listId: string) =>
      (fx.members[listId] ?? []).map((placeId, index) => ({
        entry: {
          id: `entry-${index}`,
          listId,
          placeId,
          rank: `${index}`,
          createdAt: NOW,
          updatedAt: NOW,
        },
        place: placeFor(placeId),
      })),
    ),
    allPosts: vi.fn(async () => fx.posts),
    updatePost: vi.fn(async () => {}),
    deletePost: vi.fn(async () => {}),
  };
}

type RepoProp = React.ComponentProps<typeof RepoProvider>["repo"];

function renderWith(repo: ReturnType<typeof fakeRepo>, page: React.ReactElement) {
  return render(<RepoProvider repo={repo as unknown as RepoProp}>{page}</RepoProvider>);
}

function defaultFixture(): Fixture {
  return {
    posts: fixturePosts(),
    lists: [lisbonList],
    places: [placeA, placeB],
    members: { "list-1": ["place-a", "place-b"] },
  };
}

beforeEach(() => {
  navigation.params.postId = "post-1";
  navigation.navigate.mockClear();
  canvas.projections.length = 0;
  selection.focusPlace.mockClear();
  bridge.handler = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("post reading view", () => {
  it("renders the article with soft links resolved and projects the post's places", async () => {
    const repo = fakeRepo(defaultFixture());
    renderWith(repo, <PostPage />);

    expect(await screen.findByText("A Weekend of Lisbon Coffee")).toBeInTheDocument();
    // Projected mention is live; the out-of-projection one reads as prose.
    expect(await screen.findByRole("button", { name: "Café Central" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Elsewhere" })).toBeNull();
    expect(screen.getByText("Elsewhere")).toBeInTheDocument();
    // Cross-post links: existing target is live, dangling one is prose.
    expect(await screen.findByRole("button", { name: "the deep dive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "gone" })).toBeNull();
    expect(screen.getByText("gone")).toBeInTheDocument();
    // List posts link back to their list.
    expect(screen.getByTestId("post-list-link")).toHaveTextContent("Lisbon Weekend");
    // The route projected the post onto the canvas.
    expect(canvas.projections).toContainEqual({ kind: "post", postId: "post-1" });
  });

  it("focuses the canvas from a mention and scrolls to the mention from a pin tap", async () => {
    const repo = fakeRepo(defaultFixture());
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      renderWith(repo, <PostPage />);
      const mention = await screen.findByRole("button", { name: "Café Central" });

      // Mention → pin: one focusPlace call selects and flies.
      await userEvent.click(mention);
      expect(selection.focusPlace).toHaveBeenCalledWith("place-a");

      // Pin → mention: the registered bridge handler scrolls and highlights.
      expect(bridge.handler).toBeTruthy();
      act(() => bridge.handler?.("place-a"));
      expect(scrollIntoView).toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Café Central" })).toHaveAttribute(
          "aria-current",
          "true",
        ),
      );
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("navigates to the target's reading view from a cross-post link", async () => {
    const repo = fakeRepo(defaultFixture());
    renderWith(repo, <PostPage />);
    await userEvent.click(await screen.findByRole("button", { name: "the deep dive" }));
    expect(navigation.navigate).toHaveBeenCalledWith({
      to: "/post/$postId",
      params: { postId: "post-2" },
    });
  });

  it("shows a place post's one place and projects it", async () => {
    navigation.params.postId = "post-2";
    const repo = fakeRepo(defaultFixture());
    renderWith(repo, <PostPage />);

    expect(await screen.findByText("Café Central deep dive")).toBeInTheDocument();
    expect(await screen.findByTestId("post-place-link")).toHaveTextContent("Café Central");
    expect(canvas.projections).toContainEqual({ kind: "post", postId: "post-2" });
  });
});

describe("post editor", () => {
  it("inserts a mention at the cursor when a projected pin is tapped, ignoring others", async () => {
    const repo = fakeRepo(defaultFixture());
    renderWith(repo, <PostEditorPage />);
    const body = await screen.findByTestId("post-body-input");
    expect(body).toHaveValue(READING_BODY);

    await waitFor(() => expect(bridge.handler).toBeTruthy());
    act(() => bridge.handler?.("place-b"));
    await waitFor(() =>
      expect((screen.getByTestId("post-body-input") as HTMLTextAreaElement).value).toContain(
        "[Miradouro](place:place-b)",
      ),
    );

    // The editor only offers projected pins; an unknown id is a no-op.
    const before = (screen.getByTestId("post-body-input") as HTMLTextAreaElement).value;
    act(() => bridge.handler?.("place-z"));
    expect(screen.getByTestId("post-body-input")).toHaveValue(before);
  });

  it("lists place posts of the list's members first in the Insert-post-link picker", async () => {
    const repo = fakeRepo(defaultFixture());
    renderWith(repo, <PostEditorPage />);
    await screen.findByTestId("post-body-input");

    await userEvent.click(screen.getByTestId("insert-post-link"));
    const picker = await screen.findByTestId("post-link-picker");
    await waitFor(() =>
      expect(
        within(picker)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual(["Café Central deep dive", "Miradouro at dusk", "Another guide"]),
    );

    await userEvent.click(within(picker).getByRole("button", { name: "Miradouro at dusk" }));
    expect(screen.queryByTestId("post-link-picker")).toBeNull();
    expect((screen.getByTestId("post-body-input") as HTMLTextAreaElement).value).toContain(
      "[Miradouro at dusk](post:post-3)",
    );
  });

  it("previews the sanitised article through the shared pipeline", async () => {
    const repo = fakeRepo(defaultFixture());
    renderWith(repo, <PostEditorPage />);
    const body = await screen.findByTestId("post-body-input");

    fireEvent.change(body, {
      target: {
        value: "# Morning\n\n<script>window.x=1</script>\n\nGo to [Café Central](place:place-a).",
      },
    });
    await userEvent.click(screen.getByTestId("toggle-preview"));

    const preview = await screen.findByTestId("post-preview");
    expect(within(preview).getByRole("heading", { name: "Morning" })).toBeInTheDocument();
    expect(preview.querySelector("script")).toBeNull();
    expect(within(preview).getByRole("button", { name: "Café Central" })).toBeInTheDocument();
    expect(screen.queryByTestId("post-body-input")).toBeNull();
  });

  it("autosaves the body after the debounce and flushes on Done", async () => {
    const repo = fakeRepo(defaultFixture());
    renderWith(repo, <PostEditorPage />);
    const body = await screen.findByTestId("post-body-input");

    vi.useFakeTimers();
    fireEvent.change(body, { target: { value: "New body." } });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(repo.updatePost).toHaveBeenCalledWith("post-1", { body: "New body." });
    vi.useRealTimers();

    fireEvent.change(screen.getByTestId("post-body-input"), { target: { value: "Final body." } });
    fireEvent.click(screen.getByTestId("done-editing-post"));
    await waitFor(() =>
      expect(repo.updatePost).toHaveBeenCalledWith("post-1", { body: "Final body." }),
    );
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith({
        to: "/post/$postId",
        params: { postId: "post-1" },
      }),
    );
  });

  it("saves the title on blur", async () => {
    const repo = fakeRepo(defaultFixture());
    renderWith(repo, <PostEditorPage />);
    const title = await screen.findByTestId("post-title-input");

    fireEvent.change(title, { target: { value: "A Long Weekend of Lisbon Coffee" } });
    fireEvent.blur(title);
    expect(repo.updatePost).toHaveBeenCalledWith("post-1", {
      title: "A Long Weekend of Lisbon Coffee",
    });
  });

  it("deletes the post and returns to its list, surfacing refusals instead", async () => {
    const repo = fakeRepo(defaultFixture());
    renderWith(repo, <PostEditorPage />);
    await screen.findByTestId("post-body-input");

    // Refusal (e.g. a live publication) surfaces; nothing navigates.
    repo.deletePost.mockRejectedValueOnce(new Error("Unpublish this post first."));
    await userEvent.click(screen.getByTestId("delete-post"));
    expect(await screen.findByText("Unpublish this post first.")).toBeInTheDocument();
    expect(navigation.navigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("delete-post"));
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith({
        to: "/list/$listId",
        params: { listId: "list-1" },
      }),
    );
  });
});
