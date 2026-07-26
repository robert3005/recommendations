/**
 * Membership audit for the one-control add-to-list (spec/src/map-view.md §The
 * place card, spec/src/data-model.md): current memberships render as chips and
 * are never offered again in the combobox; typing filters the available lists;
 * when the text exactly names no list — member lists included, so no duplicate
 * is minted — the FIRST option is Create "<text>". The whole flow is keyboard
 * operable (spec/src/map-view.md §Accessibility and failure).
 */
import type { List, Place } from "@placemarks/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { AddToList } from "./AddToList";

const NOW = "2026-07-26T00:00:00.000Z";

const lists: List[] = [
  {
    id: "list-1",
    name: "Lisbon cafés",
    marker: { shape: "circle", color: "#F97316" },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "list-2",
    name: "Porto",
    marker: { shape: "diamond", color: "#2457E6" },
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const place: Place = {
  id: "place-1",
  name: "Café Central",
  lat: 38.7139,
  lng: -9.1394,
  origin: "search",
  createdAt: NOW,
  updatedAt: NOW,
};

function renderAdd(
  repo: Partial<Record<"addToList" | "createList", ReturnType<typeof vi.fn>>>,
  memberListIds: string[] = [],
) {
  return render(
    <RepoProvider repo={repo as never}>
      <AddToList
        source={{ kind: "existing", placeId: place.id }}
        lists={lists}
        memberListIds={memberListIds}
      />
    </RepoProvider>,
  );
}

describe("memberships and the one-control combobox", () => {
  it("shows member lists as chips and excludes them from the popup", async () => {
    renderAdd({ addToList: vi.fn() }, ["list-1"]);
    expect(screen.getByTestId("current-list-memberships").textContent).toContain("Lisbon cafés");

    // Focus opens the popup on the remaining lists — no select, no second box.
    await userEvent.click(screen.getByTestId("add-list-choice"));
    expect(screen.queryByTestId("add-option-list-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-option-list-2")).toBeInTheDocument();
    expect(screen.queryByTestId("add-new-list-name")).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-submit")).not.toBeInTheDocument();
  });

  it("wears the combobox contract: role, aria-expanded, aria-controls", async () => {
    renderAdd({ addToList: vi.fn() });
    const combobox = screen.getByTestId("add-list-choice");
    expect(combobox).toHaveRole("combobox");
    expect(combobox).toHaveAttribute("aria-expanded", "false");
    expect(combobox.getAttribute("aria-controls")).toBeTruthy();

    await userEvent.click(combobox);
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("offers Create first when the text exactly matches no list, filtered as typed", async () => {
    renderAdd({ addToList: vi.fn() });
    await userEvent.type(screen.getByTestId("add-list-choice"), "Por");
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("data-testid", "add-create-option");
    expect(options[0]?.textContent).toContain("Create");
    expect(options[0]?.textContent).toContain("Por");
    expect(options[1]).toHaveAttribute("data-testid", "add-option-list-2");
    expect(options).toHaveLength(2); // "Lisbon cafés" filtered out
  });

  it("suppresses Create on an exact name match — including a member list's name", async () => {
    renderAdd({ addToList: vi.fn() }, ["list-2"]);
    const combobox = screen.getByTestId("add-list-choice");
    // "Porto" names the member list: no Create (no duplicate list), no option.
    await userEvent.type(combobox, "Porto");
    expect(screen.queryByTestId("add-create-option")).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-option-list-2")).not.toBeInTheDocument();

    await userEvent.clear(combobox);
    await userEvent.type(combobox, "Lisbon cafés");
    expect(screen.queryByTestId("add-create-option")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-option-list-1")).toBeInTheDocument();
  });

  it("is keyboard operable: arrows move the active option, Enter picks it", async () => {
    const repo = { addToList: vi.fn().mockResolvedValue({ status: "added", place }) };
    renderAdd(repo);
    const combobox = screen.getByTestId("add-list-choice");
    // "caf" → [Create "caf", Lisbon cafés]; ArrowDown moves off Create.
    await userEvent.type(combobox, "caf");
    expect(screen.getByTestId("add-create-option")).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByTestId("add-option-list-1")).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(repo.addToList).toHaveBeenCalledWith(
      "list-1",
      { kind: "existing", placeId: place.id },
      undefined,
    );
    // Picking closed the popup and cleared the text for the next add.
    expect(combobox).toHaveAttribute("aria-expanded", "false");
    expect(combobox).toHaveValue("");
  });

  it("Escape and clicking outside close the popup without adding", async () => {
    const repo = { addToList: vi.fn() };
    renderAdd(repo);
    const combobox = screen.getByTestId("add-list-choice");
    await userEvent.click(combobox);
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(combobox).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(combobox);
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(document.body);
    expect(combobox).toHaveAttribute("aria-expanded", "false");
    expect(repo.addToList).not.toHaveBeenCalled();
  });
});
