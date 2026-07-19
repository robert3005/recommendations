/**
 * The saved-place details sheet is a dialog in its own right. Opening it moves
 * focus inside, and closing/unmounting it restores the element that invoked it.
 */
import type { Place } from "@placemarks/domain";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaceDetailsSheet } from "./PlaceDetailsSheet";

const NOW = "2026-07-19T12:00:00.000Z";
const place: Place = {
  id: "saved-place-focus",
  origin: "manual",
  osmRefHistory: [],
  manual: { name: "Saved café", category: "cafe", lat: 38.7, lng: -9.1 },
  resolutionState: "unlinked",
  createdAt: NOW,
  updatedAt: NOW,
};

const mocks = vi.hoisted(() => ({ clearSelection: vi.fn() }));

vi.mock("../../data/hooks", () => ({
  useListIdsForPlace: () => ["list-1"],
  useLists: () => [],
  useNotesForPlace: () => [],
  usePlaceView: () => ({ place, tags: [] }),
  useTags: () => [],
}));

vi.mock("../../data/RepoContext", () => ({
  useRepo: () => ({
    addToList: vi.fn(),
    assignTag: vi.fn(),
    createList: vi.fn(),
    createNote: vi.fn(),
    deleteNote: vi.fn(),
    removePlace: vi.fn(async () => undefined),
    removeTagAssignment: vi.fn(),
    updateNote: vi.fn(),
    updatePlace: vi.fn(),
  }),
}));

vi.mock("../../state/ui", () => ({
  useUiStore: (selector: (state: { clearSelection: () => void }) => unknown) =>
    selector({ clearSelection: mocks.clearSelection }),
}));

function opener() {
  return <button type="button">Open saved place</button>;
}

describe("Phase 1 saved PlaceDetailsSheet focus management", () => {
  beforeEach(() => mocks.clearSelection.mockClear());

  it("moves focus inside the saved-place dialog when it opens", () => {
    const rendered = render(opener());
    screen.getByRole("button", { name: "Open saved place" }).focus();

    rendered.rerender(
      <>
        {opener()}
        <PlaceDetailsSheet placeId={place.id} />
      </>,
    );
    const dialog = screen.getByRole("dialog", { name: "Saved café" });

    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("restores the saved-place invoker after the dialog closes", () => {
    const rendered = render(opener());
    screen.getByRole("button", { name: "Open saved place" }).focus();
    rendered.rerender(
      <>
        {opener()}
        <PlaceDetailsSheet placeId={place.id} />
      </>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.click(close);
    expect(mocks.clearSelection).toHaveBeenCalledOnce();

    rendered.rerender(opener());

    expect(screen.getByRole("button", { name: "Open saved place" })).toHaveFocus();
  });
});
