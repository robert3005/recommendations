/** Notebook geometry (spec/src/map-view.md): two desktop widths, three mobile detents. */
import { beforeEach, describe, expect, it } from "vitest";
import { paneCovered, paneLayoutKey, usePaneStore } from "./pane";

const initial = usePaneStore.getState();

beforeEach(() => {
  usePaneStore.setState(initial, true);
});

describe("pane store", () => {
  it("collapse and expand step the desktop between split and collapsed", () => {
    const store = usePaneStore.getState();
    store.setMode("desktop");
    usePaneStore.getState().collapse();
    expect(usePaneStore.getState().desktop).toBe("collapsed");
    usePaneStore.getState().collapse();
    expect(usePaneStore.getState().desktop).toBe("collapsed");
    usePaneStore.getState().expand();
    expect(usePaneStore.getState().desktop).toBe("split");
  });

  it("collapse and expand walk the mobile detents one step at a time", () => {
    usePaneStore.getState().setMode("mobile");
    usePaneStore.getState().setSheet("full");
    usePaneStore.getState().collapse();
    expect(usePaneStore.getState().sheet).toBe("half");
    usePaneStore.getState().collapse();
    expect(usePaneStore.getState().sheet).toBe("peek");
    usePaneStore.getState().collapse();
    expect(usePaneStore.getState().sheet).toBe("peek");
    usePaneStore.getState().expand();
    expect(usePaneStore.getState().sheet).toBe("half");
    usePaneStore.getState().expand();
    expect(usePaneStore.getState().sheet).toBe("full");
  });

  it("only the mobile full detent covers the canvas", () => {
    expect(paneCovered({ mode: "desktop", sheet: "full" })).toBe(false);
    expect(paneCovered({ mode: "mobile", sheet: "half" })).toBe(false);
    expect(paneCovered({ mode: "mobile", sheet: "full" })).toBe(true);
  });

  it("the layout key changes with every geometry input, so MapLibre remeasures", () => {
    const keys = new Set([
      paneLayoutKey({ mode: "desktop", desktop: "split", sheet: "half" }),
      paneLayoutKey({ mode: "desktop", desktop: "collapsed", sheet: "half" }),
      paneLayoutKey({ mode: "mobile", desktop: "split", sheet: "half" }),
      paneLayoutKey({ mode: "mobile", desktop: "split", sheet: "peek" }),
    ]);
    expect(keys.size).toBe(4);
  });
});
