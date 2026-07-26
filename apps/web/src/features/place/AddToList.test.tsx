/**
 * AddToList handles the repository's AddResult in full (spec/src/data-model.md
 * §Normative rules): added, already-member, and the name-proximity conflict,
 * which prompts — use the existing place or keep both — never merges silently.
 * The one combobox picks or creates the list; picking is the add
 * (spec/src/map-view.md §The place card).
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

function renderWithRepo(
  repo: { addToList: ReturnType<typeof vi.fn>; createList?: ReturnType<typeof vi.fn> },
  ui: React.ReactElement,
) {
  return render(<RepoProvider repo={repo as never}>{ui}</RepoProvider>);
}

/** Type into the combobox, then click the option — picking is the add. */
async function pickList(query: string, optionTestId: string) {
  await userEvent.type(screen.getByTestId("add-list-choice"), query);
  await userEvent.click(screen.getByTestId(optionTestId));
}

describe("AddToList result handling", () => {
  it("adds an existing place to the picked list and reports it", async () => {
    const repo = { addToList: vi.fn().mockResolvedValue({ status: "added", place }) };
    const onAdded = vi.fn();
    renderWithRepo(
      repo,
      <AddToList
        source={{ kind: "existing", placeId: place.id }}
        lists={lists}
        onAdded={onAdded}
      />,
    );
    await pickList("Porto", "add-option-list-2");
    expect(repo.addToList).toHaveBeenCalledWith(
      "list-2",
      { kind: "existing", placeId: place.id },
      undefined,
    );
    expect(onAdded).toHaveBeenCalledWith(place, "list-2");
    expect(screen.getByTestId("add-message").textContent).toContain("Added");
  });

  it("creates the list and adds in one flow when the Create option is picked", async () => {
    const created: List = {
      id: "list-3",
      name: "Weekend",
      marker: { shape: "square", color: "#17A34A" },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const repo = {
      addToList: vi.fn().mockResolvedValue({ status: "added", place }),
      createList: vi.fn().mockResolvedValue(created),
    };
    const onAdded = vi.fn();
    renderWithRepo(
      repo,
      <AddToList
        source={{ kind: "existing", placeId: place.id }}
        lists={lists}
        onAdded={onAdded}
      />,
    );
    await pickList("Weekend", "add-create-option");
    expect(repo.createList).toHaveBeenCalledWith("Weekend");
    expect(repo.addToList).toHaveBeenCalledWith(
      "list-3",
      { kind: "existing", placeId: place.id },
      undefined,
    );
    expect(onAdded).toHaveBeenCalledWith(place, "list-3");
  });

  it("reports already-member instead of duplicating", async () => {
    const repo = { addToList: vi.fn().mockResolvedValue({ status: "already-member", place }) };
    const onAdded = vi.fn();
    renderWithRepo(
      repo,
      <AddToList
        source={{ kind: "existing", placeId: place.id }}
        lists={lists}
        onAdded={onAdded}
      />,
    );
    await pickList("Lisbon", "add-option-list-1");
    expect(screen.getByTestId("add-message").textContent).toContain("already");
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("prompts on a name-proximity conflict and retries with the existing place", async () => {
    const facts = {
      name: "Cafe Central",
      lat: 38.714,
      lng: -9.1395,
      origin: "google-link" as const,
    };
    const repo = {
      addToList: vi
        .fn()
        .mockResolvedValueOnce({ status: "name-proximity-conflict", existing: place })
        .mockResolvedValueOnce({ status: "added", place }),
    };
    renderWithRepo(repo, <AddToList source={{ kind: "new", facts }} lists={lists} />);
    await pickList("Lisbon", "add-option-list-1");
    expect(screen.getByTestId("name-proximity-conflict").textContent).toContain("Café Central");

    await userEvent.click(screen.getByTestId("add-use-existing"));
    expect(repo.addToList).toHaveBeenLastCalledWith(
      "list-1",
      { kind: "existing", placeId: place.id },
      undefined,
    );
    expect(screen.queryByTestId("name-proximity-conflict")).not.toBeInTheDocument();
  });

  it("keeps both on request by retrying the same source with forceNew", async () => {
    const facts = {
      name: "Cafe Central",
      lat: 38.714,
      lng: -9.1395,
      origin: "google-link" as const,
    };
    const source = { kind: "new" as const, facts };
    const repo = {
      addToList: vi
        .fn()
        .mockResolvedValueOnce({ status: "name-proximity-conflict", existing: place })
        .mockResolvedValueOnce({ status: "added", place: { ...place, id: "place-2" } }),
    };
    renderWithRepo(repo, <AddToList source={source} lists={lists} />);
    await pickList("Lisbon", "add-option-list-1");
    await userEvent.click(screen.getByTestId("add-force-new"));
    expect(repo.addToList).toHaveBeenLastCalledWith("list-1", source, { forceNew: true });
  });
});
