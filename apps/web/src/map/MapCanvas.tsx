/**
 * The persistent map canvas (spec/src/map-view.md §The grammar): a singleton
 * in the app shell, outside the route outlet — it never navigates; it
 * projects whatever the notebook shows. Owns the home overlay's list-toggle
 * row, bidirectional selection, and the pin-tap routing (post editor
 * registered → mention insertion, otherwise selection). The last viewport and
 * the home toggles persist in the repository's `settings` store.
 */
import { isEmptyFilter, matchesFilter } from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRepo } from "../data/RepoContext";
import { useLibraryFacets } from "../features/library/facets";
import { MarkerGlyph } from "../features/lists/MarkerGlyph";
import { type Viewport, viewportFromTimezone } from "../lib/viewport";
import { mapStyleProvider } from "../providers";
import { editorBridge } from "../state/editorBridge";
import { useLibraryStore } from "../state/library";
import { paneCovered, paneLayoutKey, usePaneStore } from "../state/pane";
import { useProjectionStore, useSelectionStore } from "../state/projection";
import { useUiStore } from "../state/ui";
import { MapView, type MarkPinFeature, type PlacePinFeature } from "./MapView";
import {
  fitForProjection,
  importItemMarks,
  libraryPins,
  OTHER_LAYER_ID,
  type ProjectablePlace,
  publishedPins,
  UNGROUPED_MARKER,
} from "./projectionPins";
import { useColorScheme } from "./useColorScheme";

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
  // The plate follows the chrome theme: Paper by default, Night under
  // prefers-color-scheme: dark (spec/src/design.md §Map styling).
  const basemap = mapStyleProvider.style(useColorScheme());

  const facets = useLibraryFacets();
  const lists = useLiveQuery(() => repo.listLists(), [repo]);
  const views = useLiveQuery(() => repo.listViews(), [repo]);
  const filter = useLibraryStore((s) => s.filter);
  const filterActive = !isEmptyFilter(filter);
  // Each place with the saved views it matches and whether the active filter
  // keeps it — the same judgement the notebook's result list makes.
  const placeViews = useMemo<ProjectablePlace[] | undefined>(
    () =>
      facets?.map((f) => ({
        place: f.place,
        listIds: f.listIds,
        viewIds: (views ?? []).filter((v) => matchesFilter(f, v.filter)).map((v) => v.id),
        filteredOut: filterActive && !matchesFilter(f, filter),
      })),
    [facets, views, filter, filterActive],
  );
  const post = useLiveQuery(
    () => (projection.kind === "post" ? repo.getPost(projection.postId) : undefined),
    [repo, projection.kind === "post" ? projection.postId : undefined],
  );

  // The starting camera: the persisted viewport, else a timezone-derived
  // approximation — no permission prompt, no network request
  // (spec/src/map-view.md §The grammar). The map mounts once it is known.
  const [startViewport, setStartViewport] = useState<Viewport | null>(null);
  // Each session opens on the library: once its places are known the home
  // frames them all, whatever camera the last session ended on. The stored
  // viewport is only where the map waits until then (and where an empty
  // library stays).
  const [firstLaunch, setFirstLaunch] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await repo.getSetting<Viewport>(VIEWPORT_KEY).catch(() => undefined);
      if (cancelled) return;
      setFirstLaunch(true);
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
          views: views ?? [],
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
  const fitTo = fitForProjection({
    projection,
    placePins,
    markPins,
    ...(filterActive ? { filterKey: JSON.stringify(filter) } : {}),
    firstLaunch,
  });

  // The legend (spec/src/map-view.md §Layers): one named toggle per layer —
  // every list, every saved view, and "Other places" while any place is in
  // neither. Counts are what the layer would draw under the active filter.
  const legend = useMemo(() => {
    const live = (placeViews ?? []).filter((p) => !p.filteredOut);
    const rows = [
      ...(lists ?? []).map((list) => ({
        id: list.id,
        name: list.name,
        marker: list.marker,
        count: live.filter((p) => p.listIds.includes(list.id)).length,
      })),
      ...(views ?? []).map((view) => ({
        id: view.id,
        name: view.name,
        marker: view.marker,
        count: live.filter((p) => p.viewIds?.includes(view.id)).length,
      })),
    ];
    const other = live.filter((p) => p.listIds.length === 0 && !p.viewIds?.length).length;
    if (other > 0 && rows.length > 0) {
      rows.push({
        id: OTHER_LAYER_ID,
        name: "Other places",
        marker: UNGROUPED_MARKER,
        count: other,
      });
    }
    return rows;
  }, [placeViews, lists, views]);
  // Open where there is room for it; on a phone it starts as one chip so the
  // map stays a map. Either way one press opens or closes it.
  const [legendOpen, setLegendOpen] = useState(() => usePaneStore.getState().mode === "desktop");
  const paneMode = usePaneStore((s) => s.mode);
  const lastMode = useRef(paneMode);
  useEffect(() => {
    if (lastMode.current === paneMode) return;
    lastMode.current = paneMode;
    setLegendOpen(paneMode === "desktop");
  }, [paneMode]);

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
        styleUrl={basemap.style}
        overlayFont={basemap.overlayFont}
        scheme={basemap.scheme}
        basemapLayers={basemap.basemapLayers}
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
          // Search biases toward what the map is showing.
          useUiStore.getState().setMapCenter(view.center);
          // The next launch starts where this session left off, coarsened.
          void repo
            .setSetting(VIEWPORT_KEY, coarsenViewport({ ...view.center, zoom: view.zoom }))
            .catch(() => undefined);
        }}
      />
      {/* The home overlay's legend (spec/src/map-view.md §Layers): every
          layer shows by default; a named chip toggles its places. Collapsible,
          so a long legend never owns a small screen. */}
      {!covered && projection.kind === "lists-overlay" && legend.length > 0 ? (
        <div className="absolute top-3 left-3 z-10 flex max-w-[calc(100%-4.5rem)] flex-col items-start gap-1.5">
          <button
            type="button"
            aria-expanded={legendOpen}
            onClick={() => setLegendOpen(!legendOpen)}
            data-testid="legend-toggle"
            className="rounded-pill border border-hairline bg-paper px-2.5 py-1 text-xs font-medium text-ink shadow-lift"
          >
            Layers {legendOpen ? "▾" : "▸"}
          </button>
          {legendOpen ? (
            <fieldset
              className="flex max-h-[40vh] flex-wrap gap-1.5 overflow-y-auto"
              aria-label="List toggles"
              data-testid="list-toggles"
            >
              {legend.map((layer) => {
                const hidden = hiddenListIds.includes(layer.id);
                return (
                  <button
                    key={layer.id}
                    type="button"
                    aria-pressed={!hidden}
                    aria-label={`Toggle ${layer.name}`}
                    title={layer.name}
                    onClick={() => toggleList(layer.id)}
                    data-testid={`list-toggle-${layer.id}`}
                    className={`flex max-w-[11rem] items-center gap-1.5 rounded-pill border bg-paper py-1 pr-2.5 pl-1.5 text-xs shadow-lift ${
                      hidden
                        ? "border-dashed border-hairline text-ink/50 line-through"
                        : "border-hairline text-ink"
                    }`}
                  >
                    <span className={hidden ? "opacity-40" : ""}>
                      <MarkerGlyph marker={layer.marker} size={16} />
                    </span>
                    <span className="truncate">{layer.name}</span>
                    <span className="font-mono text-[10px] text-ink/60">{layer.count}</span>
                  </button>
                );
              })}
            </fieldset>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
