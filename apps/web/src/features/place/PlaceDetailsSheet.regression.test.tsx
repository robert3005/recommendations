/**
 * The place card is position-agnostic (spec/src/map-view.md §The place card):
 * the composer supplies geometry, the card owns content, focus, and close.
 * The mobile sheet carries dialog semantics; the desktop column is a labelled
 * aside in the shell's row, not a modal (§Accessibility and failure). Both
 * keep data-testid="place-details" and clear the selection on Close.
 *
 * The card reads as a listing (§The place card): category · cuisine on one
 * muted line, the description with its Wikipedia credit exactly when the text
 * came from Wikipedia, address, compact fact rows only when the fact exists —
 * and never a coordinates row. Opening the card of a place with an osmRef
 * fires one fire-and-forget enrichment pass (stubbed here; its own contract
 * lives in enrichment.test.ts).
 */
import type { List, Place } from "@placemarks/domain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { geocoder } from "../../providers";
import { useSelectionStore } from "../../state/projection";
import { enrichPlace } from "./enrichment";
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
  usePlaceViews: () => [],
  useLists: () => lists,
  usePostsFor: () => [],
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
// The enrichment pass is the data path's contract (enrichment.test.ts); here
// only the card's fire-and-forget call site is under test.
vi.mock("./enrichment", () => ({ enrichPlace: vi.fn() }));

function renderCard(variant: "sheet" | "column", className = "test-geometry") {
  const repo = { createPost: vi.fn() };
  const view = render(
    <RepoProvider repo={repo as never}>
      <PlaceDetailsSheet placeId={place.id} variant={variant} className={className} />
    </RepoProvider>,
  );
  return { ...view, repo };
}

beforeEach(() => {
  hoisted.placeView = { place, listIds: ["list-1"] };
  useSelectionStore.setState({ selectedPlaceId: place.id });
  vi.mocked(enrichPlace).mockClear();
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

describe("the enriched listing", () => {
  const WIKIPEDIA_URL = "https://pt.wikipedia.org/wiki/Caf%C3%A9_Central_(Lisboa)";
  const enriched: Place = {
    ...place,
    category: "cafe",
    cuisine: "portuguese",
    address: "Rua Example 12",
    website: "https://cafecentral.pt",
    phone: "+351 21 000 0000",
    openingHours: "Mo-Fr 08:00-18:00; Sa 09:00-14:00",
    wheelchair: "limited",
    description: "Historic café on Rua Example, pouring bica since 1923.",
    descriptionSource: "wikipedia",
    wikipediaUrl: WIKIPEDIA_URL,
  };

  it("lays the card out as a listing: category · cuisine, description, address, fact rows", () => {
    hoisted.placeView = { place: enriched, listIds: ["list-1"] };
    renderCard("column");
    expect(screen.getByTestId("place-category")).toHaveTextContent("Cafe · Portuguese");
    expect(screen.getByTestId("place-description")).toHaveTextContent(
      "Historic café on Rua Example, pouring bica since 1923.",
    );
    expect(screen.getByTestId("place-address")).toHaveTextContent("Rua Example 12");
    // Website: a normalized https link showing its hostname as the text.
    const website = screen.getByTestId("place-website").querySelector("a");
    expect(website).toHaveAttribute("href", "https://cafecentral.pt/");
    expect(website).toHaveTextContent("cafecentral.pt");
    // Phone dials; the visible text stays as captured.
    const phone = screen.getByTestId("place-phone").querySelector("a");
    expect(phone).toHaveAttribute("href", "tel:+351210000000");
    expect(phone).toHaveTextContent("+351 21 000 0000");
    // Opening hours render the raw tag value.
    expect(screen.getByTestId("place-opening-hours")).toHaveTextContent(
      "Mo-Fr 08:00-18:00; Sa 09:00-14:00",
    );
    expect(screen.getByTestId("place-wheelchair")).toHaveTextContent("Partly accessible");
  });

  it("credits Wikipedia (CC BY-SA) exactly when the description came from Wikipedia", () => {
    hoisted.placeView = { place: enriched, listIds: ["list-1"] };
    renderCard("column");
    const credit = screen.getByTestId("place-description-credit");
    expect(credit).toHaveTextContent("Wikipedia");
    expect(credit).toHaveAttribute("href", WIKIPEDIA_URL);
    expect(credit).toHaveAttribute("rel", "noopener noreferrer");
    expect(credit.getAttribute("title")).toContain("CC BY-SA");
  });

  it("shows no credit on an OSM-tag description", () => {
    hoisted.placeView = {
      place: { ...enriched, descriptionSource: "osm" },
      listIds: ["list-1"],
    };
    renderCard("column");
    expect(screen.getByTestId("place-description")).toBeInTheDocument();
    expect(screen.queryByTestId("place-description-credit")).not.toBeInTheDocument();
  });

  it("renders no coordinates row, ever, and no fact rows for a sparse place", () => {
    renderCard("column"); // the base fixture: no enriched facts at all
    expect(screen.queryByTestId("place-coordinates")).not.toBeInTheDocument();
    expect(screen.queryByTestId("place-facts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("place-description")).not.toBeInTheDocument();
    expect(screen.queryByTestId("place-address")).not.toBeInTheDocument();
  });
});

describe("enrichment on open", () => {
  it("fires one fire-and-forget enrichPlace for a place with an osmRef", async () => {
    const withRef: Place = { ...place, osmRef: { type: "node", id: "101" } };
    hoisted.placeView = { place: withRef, listIds: ["list-1"] };
    const { repo } = renderCard("column");
    await waitFor(() => expect(enrichPlace).toHaveBeenCalledWith(repo, geocoder, withRef));
  });

  it("skips enrichment when the place has no osmRef", async () => {
    renderCard("column");
    await waitFor(() => expect(screen.getByTestId("place-details")).toHaveFocus());
    expect(enrichPlace).not.toHaveBeenCalled();
  });
});
