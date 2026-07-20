/**
 * The public reader's map and non-map article are one synchronized view — on
 * the app's SINGLETON canvas (spec/src/sharing.md §Public viewer reuses the
 * pane-and-canvas grammar): a canvas pin tap reaches its article entry
 * through the registered shared-select channel, and a keyboard activation in
 * the article selects/recentres the same pin via the canvas projection. No
 * edit controls exist in the viewer.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import { useProjectionStore } from "../../state/projection";
import { useUiStore } from "../../state/ui";
import { SharedGuideView } from "./SharedGuideView";

vi.mock("../../providers", () => ({
  poiResolver: {
    resolveExact: vi.fn(async () => ({ type: "error" })),
    searchNearby: vi.fn(async () => []),
    discover: vi.fn(async () => ({ pois: [], truncated: false })),
  },
}));

const guide: SharedGuide = {
  v: 1,
  title: "Synchronized reader",
  blocks: [
    {
      id: "alpha-block",
      type: "place",
      place: { kind: "manual", name: "Alpha viewpoint", lat: 38.71, lng: -9.14 },
    },
    {
      id: "bravo-block",
      type: "place",
      place: { kind: "manual", name: "Bravo viewpoint", lat: 38.72, lng: -9.15 },
    },
  ],
  contentHash: "fixture",
};

function placeEntry(name: string): HTMLElement {
  const entry = screen
    .getAllByTestId("shared-place")
    .find((candidate) => candidate.textContent?.includes(name));
  if (!entry) throw new Error(`missing article entry for ${name}`);
  return entry;
}

function articleActivator(entry: HTMLElement): HTMLElement {
  if (entry.matches('button, a, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])')) {
    return entry;
  }
  return (within(entry).queryByRole("button") ??
    within(entry).queryByRole("link") ??
    entry) as HTMLElement;
}

beforeEach(() => {
  useProjectionStore.setState({ projection: { kind: "all" }, sharedSelectHandler: null });
  useUiStore.setState({ selection: null, flyTo: null });
});

describe("Phase 4 public map/article synchronization", () => {
  it("synchronizes selection in both directions without exposing edit controls", async () => {
    const repo = new DexieRepository(`phase4-public-sync-${crypto.randomUUID()}`);
    const user = userEvent.setup();
    const scrolled = new Set<Element>();
    const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(function recordScroll(this: Element) {
        scrolled.add(this);
      }),
    });
    try {
      render(
        <RepoProvider repo={repo}>
          <SharedGuideView guide={guide} mode="snapshot" />
        </RepoProvider>,
      );

      // The viewer projected its places onto the singleton canvas…
      const projected = useProjectionStore.getState().projection;
      if (projected.kind !== "shared") throw new Error("viewer did not project onto the canvas");
      expect(projected.pins.map((pin) => pin.name)).toEqual(["Alpha viewpoint", "Bravo viewpoint"]);
      // …and registered the map→article channel a canvas pin tap uses.
      const handler = useProjectionStore.getState().sharedSelectHandler;
      expect(handler).toBeTruthy();

      const alphaEntry = placeEntry("Alpha viewpoint");
      scrolled.clear();
      act(() => handler?.("alpha-block"));
      await waitFor(() =>
        expect(
          [...scrolled].some((element) => element === alphaEntry || alphaEntry.contains(element)),
        ).toBe(true),
      );

      // Article → map: activation flies the canvas and marks the pin selected.
      const bravoEntry = placeEntry("Bravo viewpoint");
      const activator = articleActivator(bravoEntry);
      activator.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => {
        expect(useUiStore.getState().flyTo).toMatchObject({ lat: 38.72, lng: -9.15 });
        const current = useProjectionStore.getState().projection;
        if (current.kind !== "shared") throw new Error("projection lost");
        expect(current.pins.find((pin) => pin.key === "bravo-block")?.selected).toBe(true);
      });

      expect(screen.queryByTestId("edit-list")).not.toBeInTheDocument();
      expect(screen.queryByTestId("publish-list")).not.toBeInTheDocument();
    } finally {
      if (previousScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
          configurable: true,
          value: previousScrollIntoView,
        });
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
      repo.db.close();
    }
  });
});
