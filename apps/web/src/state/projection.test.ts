/**
 * Every selection centres (spec/src/map-view.md §Selection): both selection
 * paths bump the focus nonce, so the canvas performs one camera move whether
 * the place was picked from a pin, a row, a mention, or the viewer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useSelectionStore } from "./projection";

beforeEach(() => {
  useSelectionStore.setState({ selectedPlaceId: null, focusNonce: 0 });
});

describe("selection store", () => {
  it("focusPlace selects and centres", () => {
    useSelectionStore.getState().focusPlace("p1");
    expect(useSelectionStore.getState().selectedPlaceId).toBe("p1");
    expect(useSelectionStore.getState().focusNonce).toBe(1);
  });

  it("selectPlace (a pin tap) centres too — same grammar", () => {
    useSelectionStore.getState().selectPlace("p2");
    expect(useSelectionStore.getState().selectedPlaceId).toBe("p2");
    expect(useSelectionStore.getState().focusNonce).toBe(1);
    // Re-selecting the same place still centres it.
    useSelectionStore.getState().selectPlace("p2");
    expect(useSelectionStore.getState().focusNonce).toBe(2);
  });

  it("clearing keeps the nonce still", () => {
    useSelectionStore.getState().selectPlace("p3");
    useSelectionStore.getState().clearSelection();
    expect(useSelectionStore.getState().selectedPlaceId).toBeNull();
    expect(useSelectionStore.getState().focusNonce).toBe(1);
  });
});
