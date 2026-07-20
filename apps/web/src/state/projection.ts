/**
 * Route → canvas projection (spec/src/map-view.md §The grammar): the canvas
 * never navigates — it re-projects whatever the pane shows. Routes publish a
 * projection descriptor; the singleton canvas derives pins, dimming, and one
 * camera move from it. Routes that leave the viewport unchanged (settings)
 * simply never publish.
 */
import { useEffect } from "react";
import { create } from "zustand";

export type CanvasProjection =
  /** The Lists home: every list's points, each wearing its list marker. */
  | { kind: "all" }
  /** A list (read or Edit mode): its members; the rest of the library dimmed. */
  | { kind: "list"; listId: string }
  /**
   * A post: reading shows its embeds and the camera follows the article
   * (`focusPlaceIds` tracks the section in view); the block editor
   * (`editing`) renders embeds solid with the rest of the post's list dimmed
   * as candidates.
   */
  | { kind: "post"; postId: string; editing?: boolean; focusPlaceIds?: string[] }
  /** The import review queue: the item under review plus labelled candidates. */
  | { kind: "review"; itemId?: string }
  /** A public viewer: explicit shared pins, read-only chrome. */
  | {
      kind: "shared";
      pins: {
        key: string;
        name: string;
        lat: number;
        lng: number;
        selected?: boolean;
      }[];
    };

interface ProjectionStore {
  projection: CanvasProjection;
  setProjection: (projection: CanvasProjection) => void;
}

export const useProjectionStore = create<ProjectionStore>((set) => ({
  projection: { kind: "all" },
  setProjection: (projection) => set({ projection }),
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
