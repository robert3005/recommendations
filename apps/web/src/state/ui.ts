/** Ephemeral UI state only — domain truth lives in the repository (book/src/tech-stack.md). */
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
  selectOsm: (ref: OsmElementRef, hint?: SelectionHint) => void;
  selectPlace: (placeId: string) => void;
  clearSelection: () => void;
  openPicker: (pos: { lat: number; lng: number }) => void;
  closePicker: () => void;
  requestFlyTo: (target: { lat: number; lng: number; zoom?: number }) => void;
}

export const useUiStore = create<UiState>((set) => ({
  selection: null,
  flyTo: null,
  pickerAt: null,
  selectOsm: (ref, hint) => set({ selection: { kind: "osm", ref, ...(hint ? { hint } : {}) } }),
  selectPlace: (placeId) => set({ selection: { kind: "place", placeId } }),
  clearSelection: () => set({ selection: null }),
  openPicker: (pos) => set({ pickerAt: pos }),
  closePicker: () => set({ pickerAt: null }),
  requestFlyTo: (target) => set({ flyTo: { ...target } }),
}));
