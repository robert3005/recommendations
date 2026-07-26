/**
 * Route → canvas projection (spec/src/map-view.md §The grammar): the canvas
 * never navigates — it projects whatever the notebook shows. Routes publish a
 * projection descriptor; the singleton canvas derives pins, dimming, and one
 * camera move from it. Routes that leave the viewport unchanged (settings)
 * simply never publish.
 */
import type { ListMarker } from "@placemarks/domain";
import { useEffect } from "react";
import { create } from "zustand";

/** A published document's pin — self-contained, from the fetched document. */
export interface PublishedPin {
  /** The PublishedPlace id — the owner's PlaceId, used for #place-<id> fragments. */
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export type CanvasProjection =
  /** The Lists home: every list's places, each pin wearing its list's marker. */
  | { kind: "lists-overlay" }
  /** A list (read or edit mode): its members; the rest of the library dimmed. */
  | { kind: "list"; listId: string }
  /**
   * A post (reading or editing): its target's places — a list post its list's
   * members, a place post its one place. `focusPlaceIds` narrows the CAMERA to
   * the mentions in view as the article scrolls; it never hides pins.
   */
  | { kind: "post"; postId: string; editing?: boolean; focusPlaceIds?: string[] }
  /** Import review: the item under review plus its labelled geocoder candidates. */
  | {
      kind: "import-item";
      itemId: string;
      title: string;
      /** The imported row's own coordinates, when the source carried any. */
      coords?: { lat: number; lng: number };
      candidates: { key: string; name: string; lat: number; lng: number }[];
    }
  /** A public viewer (/l/:slug, /p/:slug): the published places, read-only chrome. */
  | {
      kind: "published-doc";
      /** Stable identity for the camera fit (e.g. "list:<slug>"). */
      docKey: string;
      /** The published list's marker; absent for post documents. */
      marker?: ListMarker;
      places: PublishedPin[];
      /** Mentions currently in view; only these are framed. */
      focusPlaceIds?: string[];
    };

/** The import review's map→notebook channel: a candidate pick or a placement click. */
export type ImportItemPick =
  | { kind: "candidate"; key: string }
  | { kind: "map-click"; lat: number; lng: number };

interface ProjectionStore {
  projection: CanvasProjection;
  setProjection: (projection: CanvasProjection) => void;
  /**
   * Registered by the mounted import review route; the canvas reports candidate
   * pin taps and manual-placement clicks here (spec/src/map-view.md §Import
   * review). Resolution itself stays with the importer.
   */
  importItemHandler: ((pick: ImportItemPick) => void) | null;
  setImportItemHandler: (handler: ((pick: ImportItemPick) => void) | null) => void;
}

export const useProjectionStore = create<ProjectionStore>((set) => ({
  projection: { kind: "lists-overlay" },
  setProjection: (projection) => set({ projection }),
  importItemHandler: null,
  setImportItemHandler: (handler) => set({ importItemHandler: handler }),
}));

/**
 * Selection is bidirectional (spec/src/map-view.md §The grammar). A pin tap
 * sets `selectedPlaceId` so the notebook can raise the place card or scroll to
 * the mention; the notebook (place rows, PostPage mentions, the public viewer)
 * calls `focusPlace` to select AND fly the camera — one flight per call.
 */
interface SelectionStore {
  selectedPlaceId: string | null;
  /** Bumped by focusPlace: the canvas performs one camera flight per bump. */
  focusNonce: number;
  /** Notebook → canvas: select the place and fly to it. */
  focusPlace: (placeId: string) => void;
  /** Canvas → notebook: select without moving the camera. */
  selectPlace: (placeId: string) => void;
  clearSelection: () => void;
}

export const useSelectionStore = create<SelectionStore>((set) => ({
  selectedPlaceId: null,
  focusNonce: 0,
  focusPlace: (placeId) => set((s) => ({ selectedPlaceId: placeId, focusNonce: s.focusNonce + 1 })),
  selectPlace: (placeId) => set({ selectedPlaceId: placeId }),
  clearSelection: () => set({ selectedPlaceId: null }),
}));

/** Publish this route's projection while it is mounted. */
export function useCanvasProjection(projection: CanvasProjection): void {
  const setProjection = useProjectionStore((s) => s.setProjection);
  // Serialized identity: routes re-render freely; the canvas re-projects only
  // when the projection actually changes.
  const key = JSON.stringify(projection);
  useEffect(() => {
    setProjection(JSON.parse(key) as CanvasProjection);
  }, [key, setProjection]);
}
