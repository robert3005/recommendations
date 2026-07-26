import { type List, markerAt } from "@placemarks/domain";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddToList } from "./AddToList";

const NOW = "2026-07-20T00:00:00.000Z";
const lists: List[] = [
  {
    id: "list-1",
    name: "Lisbon cafés",
    marker: markerAt(0),
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "list-2",
    name: "Weekend favourites",
    marker: markerAt(1),
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "list-3",
    name: "Not joined",
    marker: markerAt(2),
    createdAt: NOW,
    updatedAt: NOW,
  },
];

describe("multi-list place selection", () => {
  it("names every current list while keeping only non-members in the add picker", () => {
    render(<AddToList lists={lists} memberListIds={["list-1", "list-2"]} onPick={vi.fn()} />);

    const memberships = screen.getByTestId("current-list-memberships");
    expect(memberships).toHaveTextContent("Lisbon cafés");
    expect(memberships).toHaveTextContent("Weekend favourites");
    expect(memberships).not.toHaveTextContent("Not joined");

    expect(
      within(screen.getByTestId("add-to-list"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Add to list…", "Not joined", "+ New list…"]);
  });
});
