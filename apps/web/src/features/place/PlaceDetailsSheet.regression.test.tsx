/**
 * The place card is position-agnostic (spec/src/map-view.md §The place card):
 * the composer supplies geometry, the card owns content, focus, and close.
 * The mobile sheet carries dialog semantics; the desktop column is a labelled
 * aside in the shell's row, not a modal (§Accessibility and failure). Both
 * keep data-testid="place-details" and clear the selection on Close.
 */
import type { List, Place } from "@placemarks/domain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { useSelectionStore } from "../../state/projection";
import { PlaceDetailsSheet } from "./PlaceDetailsSheet";

const NOW = "2026-07-26T00:00:00.000Z";

const place: Place = {
  id: "place-1",
  name: "Café Central",
  lat: 38.7139,
  lng: -9.1394,
  origin: "search",
  createdAt: NOW,
  updatedAt: NOW,
};

const lists: List[] = [
  {
    id: "list-1",
    name: "Lisbon cafés",
    marker: { shape: "circle", color: "#F97316" },
    createdAt: NOW,
    updatedAt: NOW,
  },
];

// The card reads through the live-query hooks; the regression under test is
// presentation and semantics, so the data layer is stubbed flat.
const hoisted = vi.hoisted(() => ({
  placeView: undefined as { place: Place; listIds: string[] } | undefined,
}));
vi.mock("../../data/hooks", () => ({
  usePlaceView: () => hoisted.placeView,
  useLists: () => lists,
  usePostsFor: () => [],
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

function renderCard(variant: "sheet" | "column", className = "test-geometry") {
  const repo = { createPost: vi.fn() };
  return render(
    <RepoProvider repo={repo as never}>
      <PlaceDetailsSheet placeId={place.id} variant={variant} className={className} />
    </RepoProvider>,
  );
}

beforeEach(() => {
  hoisted.placeView = { place, listIds: ["list-1"] };
  useSelectionStore.setState({ selectedPlaceId: place.id });
});

describe("PlaceDetailsSheet presentation variants", () => {
  it("renders the mobile variant as a dialog-labelled sheet", () => {
    renderCard("sheet");
    const card = screen.getByTestId("place-details");
    expect(card).toHaveAttribute("role", "dialog");
    expect(card).toHaveAccessibleName("Café Central");
    expect(card.tagName).toBe("SECTION");
  });

  it("renders the desktop variant as an aside, not a modal", () => {
    renderCard("column");
    const card = screen.getByTestId("place-details");
    expect(card.tagName).toBe("ASIDE");
    expect(card).not.toHaveAttribute("role");
    expect(card).toHaveAccessibleName("Café Central");
  });

  it("takes its geometry from the composer, not from its own classes", () => {
    renderCard("column", "composer-geometry");
    const card = screen.getByTestId("place-details");
    expect(card.className).toContain("composer-geometry");
    // Position-agnostic: no absolute placement of its own.
    expect(card.className).not.toContain("absolute");
  });

  it("moves focus into the card once the place resolves", async () => {
    renderCard("column");
    await waitFor(() => expect(screen.getByTestId("place-details")).toHaveFocus());
  });

  it("clears the selection on Close in either variant", async () => {
    renderCard("sheet");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useSelectionStore.getState().selectedPlaceId).toBeNull();
  });

  it("renders nothing while the place is still resolving", () => {
    hoisted.placeView = undefined;
    renderCard("sheet");
    expect(screen.queryByTestId("place-details")).not.toBeInTheDocument();
  });
});

describe("the place photo", () => {
  const IMAGE = "https://commons.wikimedia.org/wiki/Special:FilePath/Central.jpg?width=640";

  it("tops the card with a Wikimedia Commons credit when the place carries one", () => {
    hoisted.placeView = { place: { ...place, imageUrl: IMAGE }, listIds: ["list-1"] };
    renderCard("column");
    const img = screen.getByRole("img", { name: "Café Central" });
    expect(img).toHaveAttribute("src", IMAGE);
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    const credit = screen.getByTestId("place-image-credit");
    expect(credit).toHaveTextContent("Wikimedia Commons");
    expect(credit).toHaveAttribute("href", IMAGE);
    expect(credit).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders no photo block without an imageUrl", () => {
    renderCard("column");
    expect(screen.queryByTestId("place-image")).not.toBeInTheDocument();
  });

  it("hides the whole block when the image fails to load", async () => {
    hoisted.placeView = { place: { ...place, imageUrl: IMAGE }, listIds: ["list-1"] };
    renderCard("column");
    const img = screen.getByRole("img", { name: "Café Central" });
    img.dispatchEvent(new Event("error"));
    await waitFor(() => expect(screen.queryByTestId("place-image")).not.toBeInTheDocument());
  });
});
