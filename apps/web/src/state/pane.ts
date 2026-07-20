/**
 * The content pane's state (spec/src/map-view.md §The grammar): every route
 * renders in a pane beside the persistent map canvas. Three states on both
 * form factors — desktop collapsed/split/expanded, mobile peek/half/full
 * sheet detents. Launch opens expanded on the Lists home; the map is one
 * collapse away, never a tab switch. At `expanded` the canvas is fully
 * occluded and idles.
 */
import { create } from "zustand";

export type PaneState = "collapsed" | "split" | "expanded";

interface PaneStore {
  pane: PaneState;
  setPane: (pane: PaneState) => void;
  /** One step toward the map: expanded → split → collapsed. */
  collapse: () => void;
  /** One step toward the content: collapsed → split → expanded. */
  expand: () => void;
}

export const usePaneStore = create<PaneStore>((set) => ({
  pane: "expanded",
  setPane: (pane) => set({ pane }),
  collapse: () => set((state) => ({ pane: state.pane === "expanded" ? "split" : "collapsed" })),
  expand: () => set((state) => ({ pane: state.pane === "collapsed" ? "split" : "expanded" })),
}));
