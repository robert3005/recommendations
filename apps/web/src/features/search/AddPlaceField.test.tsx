/**
 * The paste half of the search field (spec/src/map-view.md §The
 * search field): links are parsed, never fetched — except an OSM element
 * URL, whose facts come through the geocoder's exact lookup; short links ask
 * for the expanded URL.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { resetEnrichmentAttempts } from "../place/enrichment";
import { AddPlaceField } from "./AddPlaceField";

const geocoder = vi.hoisted(() => ({ search: vi.fn(), lookup: vi.fn() }));
vi.mock("../../providers", () => ({ geocoder }));

function renderField() {
  const repo = {
    listLists: vi.fn().mockResolvedValue([]),
    listPlaceViews: vi.fn().mockResolvedValue([]),
    addToList: vi.fn(),
    createList: vi.fn(),
    updatePlaceFacts: vi.fn().mockResolvedValue(undefined),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RepoProvider repo={repo as never}>
        <AddPlaceField />
      </RepoProvider>
    </QueryClientProvider>,
  );
  return repo;
}

beforeEach(() => {
  geocoder.search.mockReset();
  geocoder.lookup.mockReset();
  // The shared enrichment pass attempts each place once per session.
  resetEnrichmentAttempts();
});

describe("pasting map links", () => {
  it("asks for the expanded URL on a maps.app.goo.gl short link, and never fetches", async () => {
    renderField();
    await userEvent.click(screen.getByRole("combobox", { name: "Add a place" }));
    await userEvent.paste("https://maps.app.goo.gl/AbCdEf123");
    expect(screen.getByTestId("link-notice").textContent).toContain("full address-bar URL");
    expect(geocoder.search).not.toHaveBeenCalled();
    expect(geocoder.lookup).not.toHaveBeenCalled();
  });

  it("opens the confirm card from a Google place URL, preferring the !3d/!4d pin", async () => {
    renderField();
    await userEvent.click(screen.getByRole("combobox", { name: "Add a place" }));
    await userEvent.paste(
      "https://www.google.com/maps/place/Cervejaria+Ramiro/@38.7,-9.14,17z/data=!3d38.72331!4d-9.13539",
    );
    const card = screen.getByTestId("add-place-confirm");
    expect(card.textContent).toContain("38.72331");
    expect(screen.getByTestId("confirm-name")).toHaveValue("Cervejaria Ramiro");
  });

  it("explains when a Google link carries no location", async () => {
    renderField();
    await userEvent.click(screen.getByRole("combobox", { name: "Add a place" }));
    await userEvent.paste("https://www.google.com/maps");
    expect(screen.getByTestId("link-notice").textContent).toContain("does not carry a location");
  });

  it("looks up a pasted OSM element through the geocoder and pre-fills its facts", async () => {
    geocoder.lookup.mockResolvedValue({
      name: "Café A Brasileira",
      lat: 38.7107,
      lng: -9.1421,
      address: "Rua Garrett 122, Lisboa",
      osmRef: { type: "node", id: "42" },
    });
    renderField();
    await userEvent.click(screen.getByRole("combobox", { name: "Add a place" }));
    await userEvent.paste("https://www.openstreetmap.org/node/42");
    await waitFor(() =>
      expect(screen.getByTestId("confirm-name")).toHaveValue("Café A Brasileira"),
    );
    expect(geocoder.lookup).toHaveBeenCalledWith({ type: "node", id: "42" });
  });

  it("fails politely offline: nothing queues, retry is offered", async () => {
    geocoder.lookup.mockRejectedValueOnce(new Error("offline"));
    renderField();
    await userEvent.click(screen.getByRole("combobox", { name: "Add a place" }));
    await userEvent.paste("https://www.openstreetmap.org/way/7");
    await waitFor(() => expect(screen.getByTestId("osm-lookup-error")).toBeVisible());

    geocoder.lookup.mockResolvedValueOnce({ name: "Ponte", lat: 41.14, lng: -8.61 });
    await userEvent.click(screen.getByTestId("osm-lookup-retry"));
    await waitFor(() => expect(screen.getByTestId("confirm-name")).toHaveValue("Ponte"));
  });
});

describe("add-time enrichment of search picks", () => {
  const NOW = "2026-07-26T00:00:00.000Z";
  const ESTRELA = {
    name: "Jardim da Estrela",
    lat: 38.7154,
    lng: -9.1607,
    osmRef: { type: "way", id: "77" },
  };
  const IMAGE = "https://commons.wikimedia.org/wiki/Special:FilePath/Estrela.jpg?width=640";

  async function addSearchPick(repo: ReturnType<typeof renderField>) {
    repo.createList.mockResolvedValue({
      id: "list-1",
      name: "Lisbon",
      marker: { shape: "circle", color: "#F97316" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    repo.addToList.mockResolvedValue({
      status: "added",
      place: { id: "place-9", ...ESTRELA, origin: "search", createdAt: NOW, updatedAt: NOW },
    });
    await userEvent.type(screen.getByRole("combobox", { name: "Add a place" }), "estrela");
    await userEvent.click(await screen.findByRole("option", { name: /Jardim da Estrela/ }));
    await userEvent.type(screen.getByTestId("field-list-choice"), "Lisbon");
    await userEvent.click(screen.getByTestId("field-create-option"));
  }

  it("fires one lookup after the add and writes the missing photo and address", async () => {
    geocoder.search.mockResolvedValue([ESTRELA]);
    geocoder.lookup.mockResolvedValue({
      ...ESTRELA,
      address: "Praça da Estrela, Lisboa",
      imageUrl: IMAGE,
    });
    const repo = renderField();
    await addSearchPick(repo);

    await waitFor(() =>
      expect(repo.updatePlaceFacts).toHaveBeenCalledWith("place-9", {
        imageUrl: IMAGE,
        address: "Praça da Estrela, Lisboa",
      }),
    );
    expect(geocoder.lookup).toHaveBeenCalledTimes(1);
    expect(geocoder.lookup).toHaveBeenCalledWith(ESTRELA.osmRef);
  });

  it("is best-effort: a failed lookup writes nothing and surfaces nothing", async () => {
    geocoder.search.mockResolvedValue([ESTRELA]);
    geocoder.lookup.mockRejectedValue(new Error("offline"));
    const repo = renderField();
    await addSearchPick(repo);

    await waitFor(() => expect(geocoder.lookup).toHaveBeenCalledTimes(1));
    expect(repo.updatePlaceFacts).not.toHaveBeenCalled();
  });
});

describe("typing to search", () => {
  it("lists geocoder results and picking one opens the confirm card with its osmRef facts", async () => {
    geocoder.search.mockResolvedValue([
      {
        name: "Jardim da Estrela",
        lat: 38.7154,
        lng: -9.1607,
        address: "Lisboa",
        osmRef: { type: "way", id: "77" },
      },
    ]);
    renderField();
    await userEvent.type(screen.getByRole("combobox", { name: "Add a place" }), "estrela");
    const option = await screen.findByRole("option", { name: /Jardim da Estrela/ });
    await userEvent.click(option);
    expect(screen.getByTestId("confirm-name")).toHaveValue("Jardim da Estrela");
    expect(screen.getByTestId("add-place-confirm").textContent).toContain("38.71540");
  });
});

describe("the results dropdown", () => {
  it("puts itself away when a press lands outside the field, and comes back on focus", async () => {
    geocoder.search.mockResolvedValue([
      { name: "Café do Rio", address: "Lisboa", lat: 38.7, lng: -9.1 },
    ]);
    renderField();
    const outside = document.createElement("button");
    document.body.append(outside);
    const field = screen.getByRole("combobox", { name: "Add a place" });
    await userEvent.click(field);
    await userEvent.type(field, "cafe");
    expect(await screen.findByRole("option", { name: /Café do Rio/ })).toBeTruthy();

    await userEvent.click(outside);
    expect(screen.queryByTestId("search-panel")).toBeNull();

    await userEvent.click(field);
    expect(await screen.findByRole("option", { name: /Café do Rio/ })).toBeTruthy();
    outside.remove();
  });
});
