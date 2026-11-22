/** Ephemeral UI state only — domain truth lives in the repository (spec/src/tech-stack.md). */
import { create } from "zustand";

interface UiState {
  /** A one-shot camera request with explicit coordinates (place-card flights). */
  flyTo: { lat: number; lng: number; zoom?: number } | null;
  /**
   * The home overlay's layer toggles (spec/src/map-view.md §Layers): every
   * list and saved view shows by default; toggling hides its places. Holds
   * list ids, view ids and OTHER_LAYER_ID. Persisted in the repository's
   * `settings` store; the canvas hydrates on launch and writes on change.
   */
  hiddenListIds: readonly string[];
  /** Where the map is looking — the bias for place search. Null until the map reports. */
  mapCenter: { lat: number; lng: number } | null;
  setMapCenter: (center: { lat: number; lng: number }) => void;
  requestFlyTo: (target: { lat: number; lng: number; zoom?: number }) => void;
  toggleListVisibility: (listId: string) => void;
  /** Settings hydration on launch — not a user action. */
  setHiddenListIds: (ids: readonly string[]) => void;
}

export const useUiStore = create<UiState>((set) => ({
  flyTo: null,
  hiddenListIds: [],
  mapCenter: null,
  setMapCenter: (center) => set({ mapCenter: { lat: center.lat, lng: center.lng } }),
  requestFlyTo: (target) => set({ flyTo: { ...target } }),
  toggleListVisibility: (listId) =>
    set((state) => ({
      hiddenListIds: state.hiddenListIds.includes(listId)
        ? state.hiddenListIds.filter((id) => id !== listId)
        : [...state.hiddenListIds, listId],
    })),
  setHiddenListIds: (ids) => set({ hiddenListIds: [...ids] }),
}));
