/** Ephemeral UI state only — domain truth lives in the repository (spec/src/tech-stack.md). */
import { create } from "zustand";

interface UiState {
  /** A one-shot camera request with explicit coordinates (place-card flights). */
  flyTo: { lat: number; lng: number; zoom?: number } | null;
  /**
   * The home overlay's list toggles (spec/src/map-view.md §Home): every list
   * shows by default; toggling hides its places. Persisted in the repository's
   * `settings` store; the canvas hydrates on launch and writes on change.
   */
  hiddenListIds: readonly string[];
  requestFlyTo: (target: { lat: number; lng: number; zoom?: number }) => void;
  toggleListVisibility: (listId: string) => void;
  /** Settings hydration on launch — not a user action. */
  setHiddenListIds: (ids: readonly string[]) => void;
}

export const useUiStore = create<UiState>((set) => ({
  flyTo: null,
  hiddenListIds: [],
  requestFlyTo: (target) => set({ flyTo: { ...target } }),
  toggleListVisibility: (listId) =>
    set((state) => ({
      hiddenListIds: state.hiddenListIds.includes(listId)
        ? state.hiddenListIds.filter((id) => id !== listId)
        : [...state.hiddenListIds, listId],
    })),
  setHiddenListIds: (ids) => set({ hiddenListIds: [...ids] }),
}));
