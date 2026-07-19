/**
 * The public reader's map and non-map article are one synchronized view:
 * selecting a pin reaches its article entry, and a keyboard activation in the
 * article selects/recentres the same pin. The test accepts focus or any common
 * selected-state semantic and either MapView selection/fly-to signal.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { RepoProvider } from "../../data/RepoContext";
import { DexieRepository } from "../../data/repo";
import type { MapView } from "../../map/MapView";
import { SharedGuideView } from "./SharedGuideView";

type MapProps = ComponentProps<typeof MapView>;

const mapHarness = vi.hoisted(() => ({ latest: undefined as MapProps | undefined }));

vi.mock("../../map/MapView", () => ({
  MapView: (props: MapProps) => {
    mapHarness.latest = props;
    return (
      <div data-testid="public-map-harness">
        {props.placePins.map((pin) => (
          <button
            key={pin.placeId}
            type="button"
            onClick={() => props.onSelectPlace?.(pin.placeId)}
          >
            Map pin {pin.name}
          </button>
        ))}
      </div>
    );
  },
}));

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

function entryWasReachedOrHighlighted(entry: HTMLElement, scrolled: Set<Element>): boolean {
  return (
    entry === document.activeElement ||
    entry.contains(document.activeElement) ||
    [...scrolled].some((element) => element === entry || entry.contains(element)) ||
    entry.getAttribute("aria-current") === "true" ||
    entry.getAttribute("aria-selected") === "true" ||
    entry.dataset.selected === "true"
  );
}

function articleActivator(entry: HTMLElement): HTMLElement {
  if (entry.matches('button, a, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])')) {
    return entry;
  }
  return (within(entry).queryByRole("button") ??
    within(entry).queryByRole("link") ??
    entry) as HTMLElement;
}

function mapTargets(lat: number, lng: number): boolean {
  const props = mapHarness.latest;
  return [props?.selectionPin, props?.flyTo, props?.initialCenter].some(
    (target) => target?.lat === lat && target.lng === lng,
  );
}

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

      const alphaEntry = placeEntry("Alpha viewpoint");
      scrolled.clear();
      await user.click(screen.getByRole("button", { name: "Map pin Alpha viewpoint" }));
      await waitFor(() =>
        expect(entryWasReachedOrHighlighted(alphaEntry, scrolled)).toBe(true),
      ).catch(() => undefined);
      expect.soft(entryWasReachedOrHighlighted(alphaEntry, scrolled)).toBe(true);

      const bravoEntry = placeEntry("Bravo viewpoint");
      const activator = articleActivator(bravoEntry);
      activator.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(mapTargets(38.72, -9.15)).toBe(true)).catch(() => undefined);
      expect.soft(mapTargets(38.72, -9.15)).toBe(true);

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
