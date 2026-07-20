/** Ephemeral UI state only — domain truth lives in the repository (spec/src/tech-stack.md). */
import type { OsmElementRef } from "@placemarks/domain";
import { create } from "zustand";

export interface SelectionHint {
  name?: string;
  lat: number;
  lng: number;
  category?: string;
}

export type Selection =
  | { kind: "osm"; ref: OsmElementRef; hint?: SelectionHint }
  | { kind: "place"; placeId: string };

interface UiState {
  selection: Selection | null;
  flyTo: { lat: number; lng: number; zoom?: number } | null;
  pickerAt: { lat: number; lng: number } | null;
  /** A review-queue item awaiting manual placement — the next long-press places it. */
  placingImportItemId: string | null;
  /**
   * List toggles — the canvas's primary filter (spec/src/map-view.md §The
   * canvas): every list shows by default; toggling hides its points.
   */
  hiddenListIds: readonly string[];
  /**
   * An open post editor (spec/src/posts.md §Authoring): while set, tapping a
   * library pin offers **Embed in post** alongside the card's other actions.
   */
  embedTargetPostId: string | null;
  selectOsm: (ref: OsmElementRef, hint?: SelectionHint) => void;
  selectPlace: (placeId: string) => void;
  clearSelection: () => void;
  openPicker: (pos: { lat: number; lng: number }) => void;
  closePicker: () => void;
  requestFlyTo: (target: { lat: number; lng: number; zoom?: number }) => void;
  startPlacingImportItem: (itemId: string) => void;
  stopPlacingImportItem: () => void;
  toggleListVisibility: (listId: string) => void;
  setEmbedTargetPost: (postId: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  selection: null,
  flyTo: null,
  pickerAt: null,
  placingImportItemId: null,
  hiddenListIds: [],
  embedTargetPostId: null,
  selectOsm: (ref, hint) => set({ selection: { kind: "osm", ref, ...(hint ? { hint } : {}) } }),
  selectPlace: (placeId) => set({ selection: { kind: "place", placeId } }),
  clearSelection: () => set({ selection: null }),
  openPicker: (pos) => set({ pickerAt: pos }),
  closePicker: () => set({ pickerAt: null }),
  requestFlyTo: (target) => set({ flyTo: { ...target } }),
  startPlacingImportItem: (itemId) => set({ placingImportItemId: itemId }),
  stopPlacingImportItem: () => set({ placingImportItemId: null }),
  toggleListVisibility: (listId) =>
    set((state) => ({
      hiddenListIds: state.hiddenListIds.includes(listId)
        ? state.hiddenListIds.filter((id) => id !== listId)
        : [...state.hiddenListIds, listId],
    })),
  setEmbedTargetPost: (postId) => set({ embedTargetPostId: postId }),
}));
