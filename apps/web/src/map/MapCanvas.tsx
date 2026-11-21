/**
 * The persistent map canvas (spec/src/map-view.md §The grammar): a singleton
 * in the app shell, outside the route outlet — it never navigates; it
 * projects whatever the notebook shows. Owns the home overlay's list-toggle
 * row, bidirectional selection, and the pin-tap routing (post editor
 * registered → mention insertion, otherwise selection). The last viewport and
 * the home toggles persist in the repository's `settings` store.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { useRepo } from "../data/RepoContext";
import { MarkerGlyph } from "../features/lists/MarkerGlyph";
import { type Viewport, viewportFromTimezone } from "../lib/viewport";
import { mapStyleProvider } from "../providers";
import { editorBridge } from "../state/editorBridge";
import { paneCovered, paneLayoutKey, usePaneStore } from "../state/pane";
import { useProjectionStore, useSelectionStore } from "../state/projection";
import { useUiStore } from "../state/ui";
import { MapView, type MarkPinFeature, type PlacePinFeature } from "./MapView";
import { fitForProjection, importItemMarks, libraryPins, publishedPins } from "./projectionPins";

const VIEWPORT_KEY = "lastViewport";
const HOME_TOGGLES_KEY = "homeListToggles";

/**
 * The persisted camera is coarsened to a ~1 km grid so a Locate-driven
 * recenter never stores a precise position (spec/src/map-view.md: the start
 * camera is approximate; nothing precise leaves the session).
 */
export function coarsenViewport(view: { lat: number; lng: number; zoom: number }): Viewport {
  const coarse = (value: number) => Math.round(value * 100) / 100;
  return { lat: coarse(view.lat), lng: coarse(view.lng), zoom: coarse(view.zoom) };
}

function isViewport(value: unknown): value is Viewport {
  const v = value as Partial<Viewport> | undefined;
  return (
    typeof v?.lat === "number" &&
    typeof v.lng === "number" &&
    typeof v.zoom === "number" &&
    Number.isFinite(v.lat) &&
    Number.isFinite(v.lng) &&
    Number.isFinite(v.zoom) &&
    v.lat >= -90 &&
    v.lat <= 90 &&
    v.lng >= -180 &&
    v.lng <= 180
  );
}

export function MapCanvas() {
  const repo = useRepo();
  const projection = useProjectionStore((s) => s.projection);
  const importItemHandler = useProjectionStore((s) => s.importItemHandler);
  const selectedPlaceId = useSelectionStore((s) => s.selectedPlaceId);
  const focusNonce = useSelectionStore((s) => s.focusNonce);
  const flyTo = useUiStore((s) => s.flyTo);
  const requestFlyTo = useUiStore((s) => s.requestFlyTo);
  const hiddenListIds = useUiStore((s) => s.hiddenListIds);
  const toggleListVisibility = useUiStore((s) => s.toggleListVisibility);
  const setHiddenListIds = useUiStore((s) => s.setHiddenListIds);
  const covered = usePaneStore(paneCovered);
  const layoutKey = usePaneStore(paneLayoutKey);

  const placeViews = useLiveQuery(() => repo.listPlaceViews(), [repo]);
  const lists = useLiveQuery(() => repo.listLists(), [repo]);
  const post = useLiveQuery(
    () => (projection.kind === "post" ? repo.getPost(projection.postId) : undefined),
    [repo, projection.kind === "post" ? projection.postId : undefined],
  );

  // The starting camera: the persisted viewport, else a timezone-derived
  // approximation — no permission prompt, no network request
  // (spec/src/map-view.md §The grammar). The map mounts once it is known.
  const [startViewport, setStartViewport] = useState<Viewport | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await repo.getSetting<Viewport>(VIEWPORT_KEY).catch(() => undefined);
      if (cancelled) return;
      setStartViewport(
        isViewport(stored)
          ? stored
          : viewportFromTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [repo]);

  // Home toggles hydrate from settings once; every change writes back.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await repo.getSetting<string[]>(HOME_TOGGLES_KEY).catch(() => undefined);
      if (cancelled || !Array.isArray(stored)) return;
      setHiddenListIds(stored.filter((id): id is string => typeof id === "string"));
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, setHiddenListIds]);
  const toggleList = (listId: string) => {
    toggleListVisibility(listId);
    void repo
      .setSetting(HOME_TOGGLES_KEY, [...useUiStore.getState().hiddenListIds])
      .catch(() => undefined);
  };

  // ---- The projection: which pins the canvas draws ----
  const postTargetPlaceIds = (() => {
    if (projection.kind !== "post" || !post) return undefined;
    if (post.target.kind === "place") return new Set([post.target.placeId]);
    const listId = post.target.listId;
    return new Set(
      (placeViews ?? [])
        .filter((view) => view.listIds.includes(listId))
        .map((view) => view.place.id),
    );
  })();
  const postListId = post?.target.kind === "list" ? post.target.listId : undefined;

  const placePins: PlacePinFeature[] =
    projection.kind === "published-doc"
      ? publishedPins(projection)
      : libraryPins({
          projection,
          places: placeViews ?? [],
          lists: lists ?? [],
          hiddenListIds,
          ...(postTargetPlaceIds ? { postTargetPlaceIds } : {}),
          ...(postListId ? { postListId } : {}),
        });

  const markPins: MarkPinFeature[] =
    projection.kind === "import-item" ? importItemMarks(projection) : [];

  const placePinsRef = useRef(placePins);
  placePinsRef.current = placePins;

  // The selection is marked on the map immediately — same grammar in the
  // library and the public viewer (spec/src/map-view.md §Selection).
  const selectionPin = (() => {
    if (!selectedPlaceId) return null;
    const pin = placePins.find((p) => p.placeId === selectedPlaceId);
    return pin ? { lat: pin.lat, lng: pin.lng } : null;
  })();

  // focusPlace = select AND fly: one camera flight per bump, resolved against
  // the pins currently on the canvas.
  const appliedFocusRef = useRef(focusNonce);
  useEffect(() => {
    if (focusNonce === appliedFocusRef.current) return;
    appliedFocusRef.current = focusNonce;
    const placeId = useSelectionStore.getState().selectedPlaceId;
    const pin = placeId ? placePinsRef.current.find((p) => p.placeId === placeId) : undefined;
    if (pin) requestFlyTo({ lat: pin.lat, lng: pin.lng, zoom: 16 });
  }, [focusNonce, requestFlyTo]);

  // One camera move per projection change — never before its pins exist.
  const fitTo = fitForProjection({ projection, placePins, markPins });

  const onPinTap = (placeId: string) => {
    // While a post editor is registered a pin tap inserts a mention at the
    // cursor (spec/src/posts.md §Authoring); otherwise it selects, and the
    // notebook raises the place card or scrolls to the mention.
    if (editorBridge.isRegistered()) {
      editorBridge.emitPinTap(placeId);
      return;
    }
    useSelectionStore.getState().selectPlace(placeId);
  };

  if (!startViewport) {
    return <div className="relative h-full" data-testid="map-page" />;
  }

  return (
    <div className="relative h-full" data-testid="map-page">
      <MapView
        covered={covered}
        layoutKey={layoutKey}
        styleUrl={mapStyleProvider.style().style}
        overlayFont={mapStyleProvider.style().overlayFont}
        initialCenter={{ lat: startViewport.lat, lng: startViewport.lng }}
        initialZoom={startViewport.zoom}
        placePins={placePins}
        markPins={markPins}
        selectionPin={selectionPin}
        selectedPlaceId={selectedPlaceId}
        flyTo={flyTo}
        fitTo={fitTo}
        onSelectPlace={onPinTap}
        onSelectMark={
          projection.kind === "import-item"
            ? (mark) => importItemHandler?.({ kind: "candidate", key: mark.key })
            : undefined
        }
        onMapClick={
          // Import review's manual placement is a click on the map
          // (spec/src/map-view.md §Import review).
          projection.kind === "import-item"
            ? (pos) => importItemHandler?.({ kind: "map-click", lat: pos.lat, lng: pos.lng })
            : undefined
        }
        onViewportChange={(view) => {
          // The next launch starts where this session left off, coarsened.
          void repo
            .setSetting(VIEWPORT_KEY, coarsenViewport({ ...view.center, zoom: view.zoom }))
            .catch(() => undefined);
        }}
      />
      {/* The home overlay's toggle row (spec/src/map-view.md §Home): every
          list shows by default; toggling hides its places. */}
      {!covered && projection.kind === "lists-overlay" && (lists ?? []).length > 0 ? (
        <fieldset
          className="absolute top-3 left-3 z-10 flex max-w-[70%] flex-wrap gap-1.5"
          aria-label="List toggles"
          data-testid="list-toggles"
        >
          {(lists ?? []).map((list) => {
            const hidden = hiddenListIds.includes(list.id);
            return (
              <button
                key={list.id}
                type="button"
                aria-pressed={!hidden}
                aria-label={`Toggle ${list.name}`}
                title={list.name}
                onClick={() => toggleList(list.id)}
                data-testid={`list-toggle-${list.id}`}
                className={`rounded-pill border border-hairline bg-paper p-1 shadow-lift ${hidden ? "opacity-40" : ""}`}
              >
                <MarkerGlyph marker={list.marker} size={22} />
              </button>
            );
          })}
        </fieldset>
      ) : null}
    </div>
  );
}
