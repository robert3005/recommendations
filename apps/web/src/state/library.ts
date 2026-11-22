/**
 * The library filter (spec/src/map-view.md §The library): ephemeral UI state
 * shared by the home page, the top-bar search, and the canvas — the notebook's
 * results and the map's pins are the same filter, always. Saved views persist
 * a filter in the repository; this store only holds the one being edited.
 */
import { compactFilter, type PlaceFilter } from "@placemarks/domain";
import { create } from "zustand";

interface LibraryState {
  filter: PlaceFilter;
  setFilter: (filter: PlaceFilter) => void;
  patchFilter: (patch: Partial<PlaceFilter>) => void;
  clearFilter: () => void;
}

export const useLibraryStore = create<LibraryState>((set) => ({
  filter: {},
  setFilter: (filter) => set({ filter: compactFilter(filter) }),
  // Free text is kept verbatim while typing (trailing spaces included); every
  // other facet is compacted so equal filters compare equal.
  patchFilter: (patch) =>
    set((state) => {
      const merged = { ...state.filter, ...patch };
      const compact = compactFilter(merged);
      return {
        filter: {
          ...compact,
          ...(merged.text !== undefined && merged.text !== "" ? { text: merged.text } : {}),
        },
      };
    }),
  clearFilter: () => set({ filter: {} }),
}));

/** Toggle one value in a string-array facet. */
export function toggled(values: readonly string[] | undefined, value: string): string[] {
  const current = values ?? [];
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}
