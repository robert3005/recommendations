/**
 * What the canvas draws, as pure functions of the projection.
 *
 * Extracted from MapCanvas so the rules that are easy to get subtly wrong — which
 * marker a place in several lists wears, when a list toggle hides a place, which
 * places a post's editor shows as candidates, and which bounds a camera move
 * frames — can be tested directly, without a map, a query client or a DOM.
 */
import type { List, ListMarker, PlaceId, PlaceView } from "@placemarks/domain";
import { displayFacts } from "@placemarks/domain";
import { DEFAULT_PIN_COLOR, FALLBACK_MARKER } from "../lib/markers";
import type { MarkPinFeature, PlacePinFeature } from "./MapView";

/** The projection shapes that draw library places. */
export type LibraryProjection =
  | { kind: "all" }
  | { kind: "list"; listId: string }
  | { kind: "post"; postId: string; editing?: boolean; focusPlaceIds?: string[] };

export interface LibraryPinsInput {
  projection: LibraryProjection;
  places: readonly PlaceView[];
  /** placeId → the ids of every live list containing it. */
  membership: Readonly<Record<string, string[]>>;
  lists: readonly List[];
  /** Lists toggled off on the all-lists canvas. */
  hiddenListIds: readonly string[];
  /** The list a post editorialises, when the projection is a post. */
  postListId?: string;
  /** Places the projection puts in focus; undefined means "everything is in focus". */
  focusPlaceIds?: ReadonlySet<PlaceId>;
  /** In a post's editor, the rest of its list, shown dimmed as candidates. */
  candidatePlaceIds?: ReadonlySet<PlaceId>;
}

export function libraryPins({
  projection,
  places,
  membership,
  lists,
  hiddenListIds,
  postListId,
  focusPlaceIds,
  candidatePlaceIds,
}: LibraryPinsInput): PlacePinFeature[] {
  const listsById = new Map(lists.map((list) => [list.id, list]));

  return places.flatMap((view) => {
    const facts = displayFacts(view.place);
    if (!facts) return [];
    const memberListIds = membership[view.place.id] ?? [];
    // Deterministic marker when a place is in several lists: lowest list id leads.
    const memberLists = [...memberListIds]
      .sort()
      .map((id) => listsById.get(id))
      .filter((list): list is List => list !== undefined);
    const focused = focusPlaceIds?.has(view.place.id) ?? true;

    if (projection.kind === "post") {
      // Reading shows only the embeds; the editor adds the list as candidates.
      if (!focused && !candidatePlaceIds?.has(view.place.id)) return [];
    }
    if (projection.kind === "all") {
      // The list toggles are the canvas's primary filter: a place hides once
      // EVERY list containing it is toggled off.
      if (!memberListIds.some((id) => !hiddenListIds.includes(id))) return [];
    }

    // A list/post projection belongs to exactly one list, even if the place is
    // also a member elsewhere. Only the all-lists projection uses the
    // deterministic multi-list badge.
    const projectionList: List | undefined =
      projection.kind === "list"
        ? listsById.get(projection.listId)
        : projection.kind === "post" && postListId
          ? listsById.get(postListId)
          : undefined;
    const marker: ListMarker = projectionList?.marker ?? memberLists[0]?.marker ?? FALLBACK_MARKER;

    return [
      {
        placeId: view.place.id,
        name: facts.name ?? "Place",
        lat: facts.lat,
        lng: facts.lng,
        color: memberLists.length > 0 ? marker.color : DEFAULT_PIN_COLOR,
        icon: marker.icon,
        unlinked: view.place.resolutionState === "unlinked",
        multi: projection.kind === "all" && memberLists.length > 1,
        dimmed: !focused,
      },
    ];
  });
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
 * camera, which would yank the user somewhere they did not ask to go.
 */
export function fitForProjection(input: {
  /** The live canvas projection — structurally the union in state/projection.ts. */
  projection:
    | LibraryProjection
    | { kind: "review"; itemId?: string }
    | {
        kind: "shared";
        pins: readonly { key: string; lat: number; lng: number }[];
        focusKeys?: string[];
      }
    | { kind: "settings" };
  placePins: readonly PlacePinFeature[];
  markPins: readonly MarkPinFeature[];
  /** The review item actually loaded, if any — its absence means nothing to frame. */
  reviewItemId?: string;
}): { bounds: BBoxLike; key: string } | null {
  const { projection, placePins, markPins, reviewItemId } = input;

  if (projection.kind === "post" && projection.focusPlaceIds?.length) {
    // The camera follows the article as it scrolls (instant under reduced
    // motion — MapView owns that preference).
    const focusSet = new Set(projection.focusPlaceIds);
    const bounds = boundsOf(placePins.filter((pin) => focusSet.has(pin.placeId)));
    return bounds
      ? { bounds, key: `post:${projection.postId}:${projection.focusPlaceIds.join(",")}` }
      : null;
  }
  if (projection.kind === "list" || projection.kind === "post") {
    const bounds = boundsOf(placePins.filter((pin) => !pin.dimmed));
    const id = projection.kind === "list" ? projection.listId : projection.postId;
    return bounds ? { bounds, key: `${projection.kind}:${id}` } : null;
  }
  if (projection.kind === "review" && reviewItemId) {
    const bounds = boundsOf(markPins);
    return bounds ? { bounds, key: `review:${reviewItemId}` } : null;
  }
  if (projection.kind === "shared") {
    const focusKeys = projection.focusKeys?.length ? new Set(projection.focusKeys) : undefined;
    const framed = focusKeys
      ? projection.pins.filter((pin) => focusKeys.has(pin.key))
      : projection.pins;
    const bounds = boundsOf(framed);
    const pinKey = projection.pins
      .map((pin) => `${pin.key}:${pin.lat.toFixed(5)}:${pin.lng.toFixed(5)}`)
      .join("|");
    const focusKey = projection.focusKeys?.join(",") ?? "all";
    return bounds ? { bounds, key: `shared:${pinKey}:focus:${focusKey}` } : null;
  }
  return null;
}
