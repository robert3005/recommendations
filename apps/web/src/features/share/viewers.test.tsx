/**
 * The public viewer pages (spec/src/sharing.md §The public viewer): fetch the
 * published document from the (MSW-mounted, real) share service, render it
 * read-only, map #place-<id> fragments to selection, carry noindex, and show
 * ODbL attribution exactly when a published place has an osmRef. A revoked
 * slug is a designed "gone" state.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PublishedListContent } from "./PublishedListView";
import { PublishedPostContent } from "./PublishedPostView";

const TOKEN = "viewer-test-editor-token-0000000000000000000";

async function putDoc(kind: "lists" | "posts", slug: string, doc: unknown): Promise<Response> {
  return fetch(new URL(`/s/${kind}/${slug}`, window.location.href), {
    method: "PUT",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(doc),
  });
}

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const listDoc = {
  v: 1,
  kind: "list",
  title: "Viewer Test Lisbon",
  marker: { shape: "star", color: "#17A34A" },
  places: [
    {
      id: "place-central",
      name: "Café Central",
      lat: 38.7139,
      lng: -9.1394,
      address: "Rua Example 12",
      category: "cafe",
      osmRef: { type: "node", id: "101" },
    },
    { id: "place-pin", name: "Picnic Bench", lat: 38.72, lng: -9.15 },
  ],
  posts: [{ title: "The Write-Up", url: "https://example.test/p/the-write-up" }],
};

afterEach(() => {
  window.history.replaceState(null, "", window.location.pathname);
});

describe("PublishedListView", () => {
  it("renders the published places read-only, with noindex and ODbL attribution", async () => {
    expect([200, 201].includes((await putDoc("lists", "viewer-test-lisbon", listDoc)).status)).toBe(
      true,
    );

    renderWithQuery(<PublishedListContent slug="viewer-test-lisbon" />);

    expect(await screen.findByText("Viewer Test Lisbon")).toBeInTheDocument();
    expect(screen.getByText("Café Central")).toBeInTheDocument();
    expect(screen.getByText("Picnic Bench")).toBeInTheDocument();
    // The published posts sidebar, as published.
    expect(screen.getByTestId("published-list-post")).toHaveAttribute(
      "href",
      "https://example.test/p/the-write-up",
    );
    // osmRef present on a place → attribution + the OSM deep link.
    expect(screen.getByTestId("odbl-attribution")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "OpenStreetMap" })).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/node/101",
    );
    // Public pages are noindex by default.
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "noindex",
    );
  });

  it("maps a #place-<id> fragment to the selected place", async () => {
    await putDoc("lists", "viewer-test-fragment", { ...listDoc, title: "Viewer Test Fragment" });
    window.location.hash = "#place-place-pin";

    renderWithQuery(<PublishedListContent slug="viewer-test-fragment" />);

    const selected = await screen.findByRole("button", { name: /Picnic Bench/ });
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Café Central/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("shows the designed gone state for a revoked slug", async () => {
    await putDoc("lists", "viewer-test-revoked", { ...listDoc, title: "Viewer Test Revoked" });
    await fetch(new URL("/s/lists/viewer-test-revoked", window.location.href), {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    renderWithQuery(<PublishedListContent slug="viewer-test-revoked" />);

    const error = await screen.findByTestId("published-error");
    expect(error).toHaveAttribute("data-reason", "gone");
  });
});

describe("PublishedPostView", () => {
  it("renders the article with its list chip; no attribution without osmRef", async () => {
    await putDoc("posts", "viewer-test-post", {
      v: 1,
      kind: "post",
      title: "Viewer Test Post",
      body: "A paragraph about [Café Central](#place-place-central).",
      places: [{ id: "place-central", name: "Café Central", lat: 38.7139, lng: -9.1394 }],
      list: { title: "Viewer Test Lisbon", url: "https://example.test/l/viewer-test-lisbon" },
    });

    renderWithQuery(<PublishedPostContent slug="viewer-test-post" />);

    expect(await screen.findByText("Viewer Test Post")).toBeInTheDocument();
    const chip = screen.getByTestId("published-post-list");
    expect(chip).toHaveTextContent("Viewer Test Lisbon");
    expect(chip.querySelector("a")).toHaveAttribute(
      "href",
      "https://example.test/l/viewer-test-lisbon",
    );
    expect(screen.getByTestId("published-post-body")).toHaveTextContent(
      /A paragraph about Café Central/,
    );
    expect(screen.queryByTestId("odbl-attribution")).not.toBeInTheDocument();
  });
});
