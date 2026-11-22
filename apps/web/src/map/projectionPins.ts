/**
 * What the canvas draws, as pure functions of the projection.
 *
 * Extracted from MapCanvas so the rules that are easy to get subtly wrong —
 * which marker a place in several lists wears, when a home toggle hides a
 * place, which places a post projects, and which bounds a camera move frames —
 * can be tested directly, without a map or a DOM.
 */
import type { List, ListMarker, PlaceId } from "@placemarks/domain";
import { ACCENT_COLORS, MARKER_SHAPES } from "@placemarks/domain";
import type { CanvasProjection } from "../state/projection";
import type { MarkPinFeature, PlacePinFeature } from "./MapView";

/** A library place with its memberships — structurally repo.listPlaceViews(). */
export interface ProjectablePlace {
  place: { id: PlaceId; name: string; lat: number; lng: number };
  listIds: readonly string[];
  /** Saved views whose filter the place matches (spec/src/map-view.md §Layers). */
  viewIds?: readonly string[];
  /** The active library filter excludes the place — the home overlay hides it. */
  filteredOut?: boolean;
}

/** Anything that groups places and wears a marker: a list or a saved view. */
export interface Layer {
  id: string;
  marker: ListMarker;
}

/** The layer id of places in no list and no saved view. */
export const OTHER_LAYER_ID = "__other";

/** What a place in no group wears: a quiet neutral, outside the eight accents. */
export const UNGROUPED_MARKER: ListMarker = { shape: "circle", color: "#77776F" };

/** The pin a published post document's places wear (no list marker travels with a post). */
export const DEFAULT_PUBLISHED_MARKER: ListMarker = {
  shape: MARKER_SHAPES[0] as ListMarker["shape"],
  color: (ACCENT_COLORS[0] as { fill: string }).fill,
};

export interface LibraryPinsInput {
  projection: CanvasProjection;
  places: readonly ProjectablePlace[];
  lists: readonly List[];
  /** Saved views, layered on the home overlay beside the lists. */
  views?: readonly Layer[];
  /** Home-overlay toggles: layers switched off — list ids, view ids, OTHER_LAYER_ID. */
  hiddenListIds: readonly string[];
  /** The post projection's places — its target's members (spec/src/posts.md §Projection). */
  postTargetPlaceIds?: ReadonlySet<PlaceId>;
  /** The list a list post targets, when the projection is a post — its marker leads. */
  postListId?: string;
}

export function libraryPins({
  projection,
  places,
  lists,
  views = [],
  hiddenListIds,
  postTargetPlaceIds,
  postListId,
}: LibraryPinsInput): PlacePinFeature[] {
  if (projection.kind === "import-item" || projection.kind === "published-doc") return [];
  const listsById = new Map(lists.map((list) => [list.id, list]));
  const viewsById = new Map(views.map((view) => [view.id, view]));

  return places.flatMap((view) => {
    // Deterministic marker for a place in several lists: lowest list id leads.
    const memberLists = [...view.listIds]
      .sort()
      .map((id) => listsById.get(id))
      .filter((list): list is List => list !== undefined);
    // A place on no list wears the neutral marker wherever it shows.
    const ownMarker = memberLists[0]?.marker ?? UNGROUPED_MARKER;

    if (projection.kind === "post") {
      // A post projects its target's places and nothing else (one rule, all surfaces).
      if (!postTargetPlaceIds?.has(view.place.id)) return [];
      const marker = (postListId ? listsById.get(postListId)?.marker : undefined) ?? ownMarker;
      return [pin(view, marker, { stacked: [], dimmed: false })];
    }

    if (projection.kind === "lists-overlay") {
      // The library filter narrows the map exactly as it narrows the notebook.
      if (view.filteredOut) return [];
      // Layers: the lists a place is on, then the saved views it matches.
      const layers: Layer[] = [
        ...memberLists,
        ...[...(view.viewIds ?? [])]
          .sort()
          .map((id) => viewsById.get(id))
          .filter((layer): layer is Layer => layer !== undefined),
      ];
      if (layers.length === 0) {
        // In no group at all: its own toggle, its own neutral marker.
        if (hiddenListIds.includes(OTHER_LAYER_ID)) return [];
        return [pin(view, UNGROUPED_MARKER, { stacked: [], dimmed: false })];
      }
      // The toggles are the overlay's filter: a place hides only when EVERY
      // layer containing it is toggled off; visible layers decide the marker.
      const visible = layers.filter((layer) => !hiddenListIds.includes(layer.id));
      if (visible.length === 0) return [];
      const [lead, ...rest] = visible as [Layer, ...Layer[]];
      return [pin(view, lead.marker, { stacked: rest.map((l) => l.marker), dimmed: false })];
    }

    // List projection: members solid in the list's marker, the rest of the
    // library dimmed in its own marker (spec/src/map-view.md §The list page).
    const projected = listsById.get(projection.listId);
    const member = projected !== undefined && view.listIds.includes(projection.listId);
    const marker = member && projected ? projected.marker : ownMarker;
    return [pin(view, marker, { stacked: [], dimmed: !member })];
  });
}

function pin(
  view: ProjectablePlace,
  marker: ListMarker,
  opts: { stacked: ListMarker[]; dimmed: boolean },
): PlacePinFeature {
  return {
    placeId: view.place.id,
    name: view.place.name,
    lat: view.place.lat,
    lng: view.place.lng,
    marker,
    // The deterministic stacked/badged multi-list variant: the next list's
    // marker peeks out behind, and 3+ lists add a numeral (spec/src/design.md).
    ...(opts.stacked[0] ? { stackedMarker: opts.stacked[0] } : {}),
    listCount: opts.stacked.length + 1,
    dimmed: opts.dimmed,
  };
}

/** A published document's places as pins, wearing the document's marker. */
export function publishedPins(
  projection: Extract<CanvasProjection, { kind: "published-doc" }>,
): PlacePinFeature[] {
  const marker = projection.marker ?? DEFAULT_PUBLISHED_MARKER;
  return projection.places.map((place) => ({
    placeId: place.id,
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    marker,
    listCount: 1,
    dimmed: false,
  }));
}

/** An import item's own coordinates plus its labelled candidates (A, B, C…). */
export function importItemMarks(
  projection: Extract<CanvasProjection, { kind: "import-item" }>,
): MarkPinFeature[] {
  return [
    ...(projection.coords
      ? [
          {
            key: `${projection.itemId}:imported`,
            name: projection.title,
            label: "•",
            lat: projection.coords.lat,
            lng: projection.coords.lng,
          },
        ]
      : []),
    ...projection.candidates.map((candidate, index) => ({
      key: candidate.key,
      name: candidate.name,
      label: String.fromCharCode(65 + index),
      lat: candidate.lat,
      lng: candidate.lng,
    })),
  ];
}

export interface BBoxLike {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * A bounding box around the given points, widened to a minimum span so a single
 * pin does not produce a degenerate zoom.
 */
export function boundsOf(points: readonly { lat: number; lng: number }[]): BBoxLike | null {
  if (points.length === 0) return null;
  let west = points[0]?.lng ?? 0;
  let east = west;
  let south = points[0]?.lat ?? 0;
  let north = south;
  for (const point of points) {
    west = Math.min(west, point.lng);
    east = Math.max(east, point.lng);
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
  }
  if (east - west < 0.002) {
    west -= 0.001;
    east += 0.001;
  }
  if (north - south < 0.002) {
    south -= 0.001;
    north += 0.001;
  }
  return { west, south, east, north };
}

/**
 * One camera move per projection change, keyed so an unchanged projection never
 * re-frames. Returns null when there is nothing to frame — never a default
 * camera, which would yank the user somewhere they did not ask to go. The
 * home overlay moves the camera only twice: when a session starts it frames
 * the whole library once, and an active library filter frames its results.
 * Toggling a layer or clearing the filter leaves the camera where it is.
 */
export function fitForProjection(input: {
  projection: CanvasProjection;
  placePins: readonly PlacePinFeature[];
  markPins: readonly MarkPinFeature[];
  /** Identity of the active library filter; absent when there is none. */
  filterKey?: string;
  /** The session's opening frame is still owed (applied once — the key never changes). */
  firstLaunch?: boolean;
}): { bounds: BBoxLike; key: string } | null {
  const { projection, placePins, markPins, filterKey, firstLaunch } = input;

  if (projection.kind === "lists-overlay") {
    if (filterKey !== undefined) {
      const bounds = boundsOf(placePins);
      return bounds ? { bounds, key: `filter:${filterKey}` } : null;
    }
    if (firstLaunch) {
      const bounds = boundsOf(placePins);
      return bounds ? { bounds, key: "library:launch" } : null;
    }
    return null;
  }

  if (projection.kind === "list") {
    const bounds = boundsOf(placePins.filter((pin) => !pin.dimmed));
    return bounds ? { bounds, key: `list:${projection.listId}` } : null;
  }
  if (projection.kind === "post") {
    // The camera follows the article as it scrolls (instant under reduced
    // motion — MapView owns that preference).
    if (projection.focusPlaceIds?.length) {
      const focus = new Set(projection.focusPlaceIds);
      const bounds = boundsOf(placePins.filter((pin) => focus.has(pin.placeId)));
      return bounds
        ? { bounds, key: `post:${projection.postId}:${projection.focusPlaceIds.join(",")}` }
        : null;
    }
    const bounds = boundsOf(placePins);
    return bounds ? { bounds, key: `post:${projection.postId}` } : null;
  }
  if (projection.kind === "import-item") {
    const bounds = boundsOf(markPins);
    return bounds ? { bounds, key: `import-item:${projection.itemId}` } : null;
  }
  if (projection.kind === "published-doc") {
    if (projection.focusPlaceIds?.length) {
      const focus = new Set(projection.focusPlaceIds);
      const bounds = boundsOf(placePins.filter((pin) => focus.has(pin.placeId)));
      return bounds
        ? { bounds, key: `${projection.docKey}:${projection.focusPlaceIds.join(",")}` }
        : null;
    }
    const bounds = boundsOf(placePins);
    return bounds ? { bounds, key: projection.docKey } : null;
  }
  return null;
}
