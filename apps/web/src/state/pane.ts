/**
 * The notebook's geometry (spec/src/map-view.md §The grammar). Desktop has two
 * widths — split (default) or collapsed (full-bleed map). Mobile is a sheet
 * over the canvas with three detents — peek, half, full. Only the mobile
 * `full` detent covers the canvas; while covered, projections apply lazily on
 * reveal (a simple guard in MapView, no idle machinery).
 */
import { create } from "zustand";

export type DesktopPane = "split" | "collapsed";
export type SheetDetent = "peek" | "half" | "full";
export type LayoutMode = "desktop" | "mobile";

export interface PaneState {
  /** Which form factor's geometry applies — the shell sets it from a media query. */
  mode: LayoutMode;
  desktop: DesktopPane;
  sheet: SheetDetent;
  setMode: (mode: LayoutMode) => void;
  setDesktop: (pane: DesktopPane) => void;
  setSheet: (detent: SheetDetent) => void;
  /** One step toward the map: full → half → peek, split → collapsed. */
  collapse: () => void;
  /** One step toward the content: peek → half → full, collapsed → split. */
  expand: () => void;
}

export const usePaneStore = create<PaneState>((set) => ({
  mode: "desktop",
  desktop: "split",
  sheet: "half",
  setMode: (mode) => set({ mode }),
  setDesktop: (desktop) => set({ desktop }),
  setSheet: (sheet) => set({ sheet }),
  collapse: () =>
    set((s) =>
      s.mode === "desktop"
        ? { desktop: "collapsed" }
        : { sheet: s.sheet === "full" ? "half" : "peek" },
    ),
  expand: () =>
    set((s) =>
      s.mode === "desktop" ? { desktop: "split" } : { sheet: s.sheet === "peek" ? "half" : "full" },
    ),
}));

/** True while the notebook fully covers the canvas (mobile `full` only). */
export function paneCovered(s: Pick<PaneState, "mode" | "sheet">): boolean {
  return s.mode === "mobile" && s.sheet === "full";
}

/** Changes whenever the canvas's CSS box can change, so MapLibre remeasures. */
export function paneLayoutKey(s: Pick<PaneState, "mode" | "desktop" | "sheet">): string {
  return `${s.mode}:${s.desktop}:${s.sheet}`;
}
