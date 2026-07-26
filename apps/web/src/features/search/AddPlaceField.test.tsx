/**
 * The paste half of the add-a-place field (spec/src/map-view.md §The
 * add-a-place field): links are parsed, never fetched — except an OSM element
 * URL, whose facts come through the geocoder's exact lookup; short links ask
 * for the expanded URL.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { AddPlaceField } from "./AddPlaceField";

const geocoder = vi.hoisted(() => ({ search: vi.fn(), lookup: vi.fn() }));
vi.mock("../../providers", () => ({ geocoder }));

function renderField() {
  const repo = { listLists: vi.fn().mockResolvedValue([]), addToList: vi.fn() };
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
