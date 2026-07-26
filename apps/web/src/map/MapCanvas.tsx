/**
 * The persistent map canvas (spec/src/map-view.md §The grammar): a singleton
 * in the app shell, outside the route outlet — it never navigates; it
 * re-projects whatever the pane shows. Owns the floating canvas chrome
 * (search, the list-toggles row — the primary filter, category chips behind
 * the search affordance for live-POI discovery, hints, the accessible
 * nearby list) and the map-borne dialogs (place sheet, candidate picker,
 * manual pin). While the pane fully occludes it, the canvas idles: rendering
 * input freezes, viewport discovery stops, and projection changes coalesce
 * into one camera move on reveal.
 */
import type { BBox, ResolvedPoi } from "@placemarks/domain";
import { displayFacts, refKey } from "@placemarks/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { DISCOVER_MIN_ZOOM } from "../config";
import { useLibraryPlaces, useListMembership, useLists, usePostBlocks } from "../data/hooks";
import { useDexieRepo, useRepo } from "../data/RepoContext";
import { resolveReviewItem } from "../features/interop/importer";
import { MarkerGlyph } from "../features/lists/MarkerGlyph";
import { TOP_CATEGORIES, type TopCategory, topCategoryOf } from "../features/map/categories";
import { CandidatePicker } from "../features/picker/CandidatePicker";
import { ManualPinDialog } from "../features/picker/ManualPinDialog";
import { SearchBar } from "../features/search/SearchBar";
import { newId } from "../lib/id";
import { DEFAULT_PIN_COLOR, FALLBACK_MARKER } from "../lib/markers";
import { nowIso } from "../lib/time";
import { initialViewport, persistViewport } from "../lib/viewport";
import { mapStyleProvider, poiResolver, searchProvider } from "../providers";
import { usePaneStore } from "../state/pane";
import { useProjectionStore } from "../state/projection";
import { useUiStore } from "../state/ui";
import { MapView, type MarkPinFeature, type PlacePinFeature, type PoiPinFeature } from "./MapView";

interface Viewport {
  bbox: BBox;
  zoom: number;
}

function roundBbox(bbox: BBox): string {
  return [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(4)).join(",");
}

function boundsOf(points: { lat: number; lng: number }[]): BBox | undefined {
  if (points.length === 0) return undefined;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    west = Math.min(west, point.lng);
    south = Math.min(south, point.lat);
    east = Math.max(east, point.lng);
    north = Math.max(north, point.lat);
  }
  // A single point still frames: give it a small span.
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

export interface MapCanvasProps {
  readOnly?: boolean;
  routeViewport?: { lat?: number; lng?: number; zoom?: number };
  onRouteViewportChange?: (viewport: { lat: number; lng: number; zoom: number }) => void;
}

export function MapCanvas({
  readOnly = false,
  routeViewport = {},
  onRouteViewportChange,
}: MapCanvasProps) {
  const repo = useRepo();
  const dexieRepo = useDexieRepo();
  const queryClient = useQueryClient();
  const selection = useUiStore((s) => s.selection);
  const flyTo = useUiStore((s) => s.flyTo);
  const pickerAt = useUiStore((s) => s.pickerAt);
  const selectOsm = useUiStore((s) => s.selectOsm);
  const selectPlace = useUiStore((s) => s.selectPlace);
  const openPicker = useUiStore((s) => s.openPicker);
  const closePicker = useUiStore((s) => s.closePicker);
  const requestFlyTo = useUiStore((s) => s.requestFlyTo);
  const placingImportItemId = useUiStore((s) => s.placingImportItemId);
  const stopPlacingImportItem = useUiStore((s) => s.stopPlacingImportItem);
  const setImportReviewError = useUiStore((s) => s.setImportReviewError);
  const clearImportReviewError = useUiStore((s) => s.clearImportReviewError);
  const hiddenListIds = useUiStore((s) => s.hiddenListIds);
  const toggleListVisibility = useUiStore((s) => s.toggleListVisibility);
  const projection = useProjectionStore((s) => s.projection);
  // At pane `expanded` / sheet `full` the canvas is fully occluded and IDLES
  // (spec/src/map-view.md §The grammar).
  const pane = usePaneStore((s) => s.pane);
  const setPane = usePaneStore((s) => s.setPane);
  const idle = pane === "expanded";

  const libraryPlaces = useLibraryPlaces();
  const lists = useLists();
  const membership = useListMembership();
  const postBlocks = usePostBlocks(projection.kind === "post" ? projection.postId : undefined);
  const post = useLiveQuery(
    () => (projection.kind === "post" ? repo.getPost(projection.postId) : undefined),
    [repo, projection.kind === "post" ? projection.postId : undefined],
  );
  const reviewItem = useLiveQuery(
    () =>
      projection.kind === "review" && projection.itemId
        ? dexieRepo.db.importItems.get(projection.itemId)
        : undefined,
    [dexieRepo, projection.kind === "review" ? projection.itemId : undefined],
  );
  const [manualAt, setManualAt] = useState<{ lat: number; lng: number } | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  // Active top-level category chips; none active shows everything. The chips
  // filter live-POI discovery only — demoted behind the search affordance
  // (spec/src/map-view.md §The canvas).
  const [activeFilters, setActiveFilters] = useState<ReadonlySet<TopCategory>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The starting camera: last viewport, else a timezone-derived approximation
  // (spec/src/map-view.md — no permission prompt, nothing leaves the device).
  const routeCamera =
    routeViewport.lat !== undefined &&
    routeViewport.lng !== undefined &&
    routeViewport.zoom !== undefined
      ? { lat: routeViewport.lat, lng: routeViewport.lng, zoom: routeViewport.zoom }
      : undefined;
  const routeCameraKey = routeCamera
    ? `${routeCamera.lat.toString()},${routeCamera.lng.toString()},${routeCamera.zoom.toString()}`
    : undefined;
  // A route camera present at mount is consumed by MapLibre's constructor.
  // Later values that did not originate from this canvas are back/forward or
  // bookmark navigation and must move the retained instance.
  const lastReportedRouteCameraKey = useRef(routeCameraKey);
  const [startViewport] = useState(() => {
    return routeCamera ?? initialViewport();
  });
  const restoredRouteCamera =
    routeCamera && routeCameraKey && routeCameraKey !== lastReportedRouteCameraKey.current
      ? { ...routeCamera, key: routeCameraKey }
      : null;
  const privateMapProjection =
    projection.kind === "all" || projection.kind === "list" || projection.kind === "post";
  const interactiveChrome = privateMapProjection && !readOnly && !idle;
  const discoverEnabled =
    interactiveChrome && viewport !== null && viewport.zoom >= DISCOVER_MIN_ZOOM;

  // `enabled: false` does not cancel a request which was already running.
  // Full occlusion explicitly aborts the query's signal; unmounting search
  // below likewise cancels its now-unobserved request.
  useEffect(() => {
    if (idle || readOnly || !privateMapProjection) {
      void queryClient.cancelQueries({ queryKey: ["discover"] });
    }
  }, [idle, privateMapProjection, queryClient, readOnly]);

  // Bounded, debounced viewport POI discovery (spec/src/data-sources.md
  // budgets). An idle canvas issues NO requests at all.
  const discoverQuery = useQuery({
    queryKey: ["discover", viewport ? roundBbox(viewport.bbox) : ""],
    queryFn: ({ signal }) => {
      if (!viewport) throw new Error("no viewport");
      return poiResolver.discover(viewport.bbox, { signal });
    },
    enabled: discoverEnabled,
    staleTime: 5 * 60_000,
  });

  const poiPins: PoiPinFeature[] = (
    discoverEnabled
      ? (discoverQuery.data?.pois ?? []).map((poi: ResolvedPoi) => ({
          refKey: refKey(poi.osmRef),
          ref: poi.osmRef,
          name: poi.name ?? "Unnamed",
          category: poi.category,
          lat: poi.lat,
          lng: poi.lng,
        }))
      : []
  ).filter((pin) => {
    if (activeFilters.size === 0) return true;
    const top = topCategoryOf(pin.category);
    return top !== undefined && activeFilters.has(top);
  });

  // ---- The projection: which library places show, and which are dimmed ----
  const listsById = new Map((lists ?? []).map((l) => [l.id, l]));
  const focusPlaceIds = (() => {
    if (projection.kind === "list") {
      return new Set(
        Object.entries(membership ?? {})
          .filter(([, listIds]) => listIds.includes(projection.listId))
          .map(([placeId]) => placeId),
      );
    }
    if (projection.kind === "post") {
      return new Set(
        (postBlocks ?? [])
          .filter((view) => view.block.content.type === "place" && view.place)
          .map((view) => (view.place ? view.place.id : "")),
      );
    }
    return undefined;
  })();
  // A post's canvas shows its embeds; the block editor additionally shows the
  // rest of the post's list dimmed as candidates (spec/src/map-view.md).
  const postCandidateIds =
    projection.kind === "post" && projection.editing && post
      ? new Set(
          Object.entries(membership ?? {})
            .filter(([, listIds]) => listIds.includes(post.listId))
            .map(([placeId]) => placeId),
        )
      : undefined;

  const placePins: PlacePinFeature[] =
    !privateMapProjection || readOnly
      ? []
      : (libraryPlaces ?? []).flatMap((view) => {
          const facts = displayFacts(view.place);
          if (!facts) return [];
          const memberListIds = membership?.[view.place.id] ?? [];
          // Deterministic marker when in several lists: the lowest list id leads.
          const memberLists = [...memberListIds]
            .sort()
            .map((id) => listsById.get(id))
            .filter((l): l is NonNullable<typeof l> => l !== undefined);
          const focused = focusPlaceIds?.has(view.place.id) ?? true;
          if (projection.kind === "post") {
            // Reading shows only the embeds; the editor adds the list as candidates.
            if (!focused && !postCandidateIds?.has(view.place.id)) return [];
          }
          if (projection.kind === "all") {
            // The list toggles are the canvas's primary filter: a place hides once
            // EVERY list containing it is toggled off.
            const visible = memberListIds.some((id) => !hiddenListIds.includes(id));
            if (!visible) return [];
          }
          // A list/post projection belongs to exactly one list, even if a place is
          // also a member elsewhere. Only the all-lists projection uses the
          // deterministic multi-list badge.
          const projectionList =
            projection.kind === "list"
              ? listsById.get(projection.listId)
              : projection.kind === "post" && post
                ? listsById.get(post.listId)
                : undefined;
          const marker = projectionList?.marker ?? memberLists[0]?.marker ?? FALLBACK_MARKER;
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

  // Review projection: the item under review plus its labelled candidates on
  // the MAIN canvas (spec/src/interop.md §Import queue model — the bespoke
  // mini map is retired).
  const markPins: MarkPinFeature[] =
    projection.kind === "review" && reviewItem
      ? [
          ...(reviewItem.coords
            ? [
                {
                  key: `${reviewItem.id}:imported`,
                  name: reviewItem.raw.title,
                  label: "•",
                  lat: reviewItem.coords.lat,
                  lng: reviewItem.coords.lng,
                },
              ]
            : []),
          ...(reviewItem.candidates ?? []).map((candidate, index) => ({
            key: `${reviewItem.id}:${candidate.ref.type}/${candidate.ref.id}`,
            name: candidate.name,
            label: String.fromCharCode(65 + index),
            lat: candidate.lat,
            lng: candidate.lng,
          })),
        ]
      : [];

  // The selection is marked on the map immediately, listed or not. In the
  // public viewer the selected shared pin wears the ring.
  const selectionPin =
    projection.kind === "shared"
      ? (() => {
          const selected = projection.pins.find((pin) => pin.selected);
          return selected ? { lat: selected.lat, lng: selected.lng } : null;
        })()
      : readOnly || !privateMapProjection
        ? null
        : selection?.kind === "osm" && selection.hint
          ? { lat: selection.hint.lat, lng: selection.hint.lng }
          : selection?.kind === "place"
            ? (() => {
                const view = (libraryPlaces ?? []).find((v) => v.place.id === selection.placeId);
                const facts = view ? displayFacts(view.place) : undefined;
                return facts ? { lat: facts.lat, lng: facts.lng } : null;
              })()
            : null;

  // One camera move per projection change — never before its pins exist.
  const fitTo = (() => {
    if (projection.kind === "post" && projection.focusPlaceIds?.length) {
      // The camera follows the article as it scrolls (instant under reduced
      // motion — MapView handles the preference).
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
    if (projection.kind === "review" && reviewItem) {
      const bounds = boundsOf(markPins);
      return bounds ? { bounds, key: `review:${reviewItem.id}` } : null;
    }
    if (projection.kind === "shared") {
      const focusKeys = projection.focusKeys?.length ? new Set(projection.focusKeys) : undefined;
      const framedPins = focusKeys
        ? projection.pins.filter((pin) => focusKeys.has(pin.key))
        : projection.pins;
      const bounds = boundsOf(framedPins);
      const pinKey = projection.pins
        .map((pin) => `${pin.key}:${pin.lat.toFixed(5)}:${pin.lng.toFixed(5)}`)
        .join("|");
      const focusKey = projection.focusKeys?.join(",") ?? "all";
      return bounds ? { bounds, key: `shared:${pinKey}:focus:${focusKey}` } : null;
    }
    return null;
  })();

  const sharedPins: MarkPinFeature[] =
    projection.kind === "shared"
      ? projection.pins.map((pin, index) => ({
          key: pin.key,
          name: pin.name,
          label: String(index + 1),
          lat: pin.lat,
          lng: pin.lng,
          ...(pin.unlinked ? { unlinked: true } : {}),
        }))
      : [];

  // Idling needs no snapshot: every projection effect in MapView is gated on
  // `idle` and lists it as a dependency, so while hidden nothing is applied and
  // on reveal each one re-runs against the CURRENT values. Freezing the props
  // here was a second mechanism for the same thing — and a staler one.
  const shownMarkPins = projection.kind === "shared" ? sharedPins : markPins;

  return (
    <div className="relative h-full" data-testid="map-page" data-canvas-idle={idle ? "1" : "0"}>
      <MapView
        idle={idle}
        layoutKey={pane}
        styleUrl={mapStyleProvider.style().styleUrl}
        initialCenter={{ lat: startViewport.lat, lng: startViewport.lng }}
        initialZoom={startViewport.zoom}
        routeCamera={restoredRouteCamera}
        placePins={placePins}
        poiPins={poiPins}
        markPins={shownMarkPins}
        selectionPin={selectionPin}
        flyTo={flyTo}
        fitTo={fitTo}
        onSelectPlace={
          readOnly
            ? undefined
            : (placeId) => {
                selectPlace(placeId);
                if (projection.kind === "post") {
                  useProjectionStore.getState().postSelectHandler?.(placeId);
                }
              }
        }
        onSelectPoi={
          readOnly
            ? undefined
            : (pin) =>
                selectOsm(pin.ref, {
                  name: pin.name,
                  lat: pin.lat,
                  lng: pin.lng,
                  category: pin.category,
                })
        }
        onSelectMark={(mark) => {
          // A shared-pin tap selects its article entry in the viewer pane.
          if (projection.kind === "shared") {
            useProjectionStore.getState().sharedSelectHandler?.(mark.key);
            return;
          }
          // A review candidate mark resolves the item to that candidate.
          if (projection.kind !== "review" || !reviewItem) return;
          const candidate = (reviewItem.candidates ?? []).find(
            (c) => `${reviewItem.id}:${c.ref.type}/${c.ref.id}` === mark.key,
          );
          if (!candidate) return;
          void (async () => {
            try {
              const outcome = await resolveReviewItem(
                dexieRepo,
                { search: searchProvider, resolver: poiResolver },
                reviewItem.id,
                { kind: "candidate", ref: candidate.ref },
                nowIso(),
              );
              if (outcome.status === "pending") {
                setImportReviewError(reviewItem.id, outcome.reason);
                setPane("split");
                return;
              }
              if (outcome.status === "resolved") {
                clearImportReviewError();
                const placed = await dexieRepo.db.importItems.get(reviewItem.id);
                if (placed?.placeId) selectPlace(placed.placeId);
              }
            } catch (error) {
              setImportReviewError(
                reviewItem.id,
                error instanceof Error ? error.message : String(error),
              );
              setPane("split");
            }
          })();
        }}
        onLongPress={
          readOnly
            ? undefined
            : (pos) => {
                // Placing a review-queue import item: the long-press IS the placement.
                if (placingImportItemId) {
                  const itemId = placingImportItemId;
                  stopPlacingImportItem();
                  void (async () => {
                    try {
                      const outcome = await resolveReviewItem(
                        dexieRepo,
                        { search: searchProvider, resolver: poiResolver },
                        itemId,
                        { kind: "coords", lat: pos.lat, lng: pos.lng },
                        nowIso(),
                      );
                      if (outcome.status === "pending") {
                        setImportReviewError(itemId, outcome.reason);
                        setPane("split");
                        return;
                      }
                      if (outcome.status === "resolved") {
                        clearImportReviewError();
                        const placed = await dexieRepo.db.importItems.get(itemId);
                        if (placed?.placeId) selectPlace(placed.placeId);
                      }
                    } catch (error) {
                      setImportReviewError(
                        itemId,
                        error instanceof Error ? error.message : String(error),
                      );
                      setPane("split");
                    }
                  })();
                  return;
                }
                openPicker(pos);
              }
        }
        onViewportChange={(view) => {
          setViewport(view);
          // The next launch starts where this session left off — coarsened to
          // a ~1 km grid so a Locate-driven recenter never persists a precise
          // position (spec/src/map-view.md: nothing precise leaves the session).
          const coarse = (value: number) => Math.round(value * 100) / 100;
          const nextViewport = {
            lat: coarse(view.center.lat),
            lng: coarse(view.center.lng),
            zoom: Math.round(view.zoom * 100) / 100,
          };
          persistViewport(nextViewport);
          lastReportedRouteCameraKey.current = `${nextViewport.lat.toString()},${nextViewport.lng.toString()},${nextViewport.zoom.toString()}`;
          // The singleton map survives this replace-navigation; typed route
          // search makes the current view restorable/bookmarkable without
          // adding one history entry per pan gesture.
          onRouteViewportChange?.(nextViewport);
        }}
      />
      {!idle && !readOnly && placingImportItemId ? (
        <div
          role="status"
          className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full bg-orange-700/90 px-3 py-1 text-xs text-white"
          data-testid="placing-import-hint"
        >
          <span>Long-press (or right-click) the map to place the imported item</span>
          <button
            type="button"
            className="ml-2 font-semibold underline"
            onClick={stopPlacingImportItem}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {/* The list toggles row — the canvas's primary filter
          (spec/src/map-view.md §The canvas): every list shows by default. */}
      {interactiveChrome && projection.kind === "all" && (lists ?? []).length > 0 ? (
        <fieldset
          className="absolute top-16 left-3 z-10 flex max-w-[60%] flex-wrap gap-1.5"
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
                onClick={() => toggleListVisibility(list.id)}
                data-testid={`list-toggle-${list.id}`}
                className={`rounded-full bg-white/95 p-0.5 shadow ${hidden ? "opacity-40" : ""}`}
              >
                <MarkerGlyph marker={list.marker} size={22} />
              </button>
            );
          })}
        </fieldset>
      ) : null}
      {/* Category chips (spec/src/map-view.md): demoted behind the search
          affordance; they filter live-POI discovery only. */}
      {interactiveChrome && filtersOpen ? (
        <fieldset
          className="absolute top-28 left-1/2 z-10 flex w-[calc(100%-1.5rem)] min-w-0 max-w-md -translate-x-1/2 flex-wrap gap-1.5"
          aria-label="Filter nearby places by category"
        >
          {TOP_CATEGORIES.map(({ key, label }) => {
            const active = activeFilters.has(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  setActiveFilters((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium shadow ${
                  active ? "bg-stone-800 text-white" : "bg-white/95 text-stone-700"
                }`}
              >
                {label}
              </button>
            );
          })}
        </fieldset>
      ) : null}
      {/* The synchronized non-map equivalent of canvas results
          (spec/src/map-view.md §Accessibility): every discovered POI is
          reachable by keyboard and screen reader. */}
      {interactiveChrome && poiPins.length > 0 ? (
        <section
          aria-label="Nearby places (list view)"
          className="absolute bottom-16 left-3 z-10 max-h-40 w-56 overflow-y-auto rounded-lg bg-white/95 p-1.5 text-xs shadow"
        >
          <ul>
            {poiPins.map((pin) => (
              <li key={pin.refKey}>
                <button
                  type="button"
                  className="w-full rounded px-1.5 py-1 text-left hover:bg-stone-100"
                  onClick={() =>
                    selectOsm(pin.ref, {
                      name: pin.name,
                      lat: pin.lat,
                      lng: pin.lng,
                      category: pin.category,
                    })
                  }
                >
                  <span className="font-medium text-stone-800">{pin.name}</span>{" "}
                  <span className="text-stone-500">({pin.category})</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {interactiveChrome ? (
        <div className="absolute top-3 left-1/2 z-10 flex w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2 items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <SearchBar
              onSelect={(result) => {
                selectOsm(result.ref, {
                  name: result.name,
                  lat: result.lat,
                  lng: result.lng,
                  ...(result.category ? { category: result.category } : {}),
                });
                requestFlyTo({ lat: result.lat, lng: result.lng, zoom: 17 });
              }}
            />
          </div>
          <button
            type="button"
            aria-pressed={filtersOpen}
            aria-label="Nearby category filters"
            data-testid="toggle-category-chips"
            onClick={() => setFiltersOpen((open) => !open)}
            className={`shrink-0 rounded-full px-2.5 py-1.5 text-xs font-medium shadow ${
              filtersOpen || activeFilters.size > 0
                ? "bg-stone-800 text-white"
                : "bg-white/95 text-stone-700"
            }`}
          >
            ⚲
          </button>
        </div>
      ) : null}
      {interactiveChrome && viewport && !discoverEnabled ? (
        <div className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full bg-stone-800/85 px-3 py-1 text-xs text-white">
          Zoom in to see nearby places
        </div>
      ) : null}
      {discoverEnabled && discoverQuery.data?.truncated ? (
        <div className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full bg-stone-800/85 px-3 py-1 text-xs text-white">
          Showing a capped set of places — zoom in for more
        </div>
      ) : null}
      {discoverEnabled && discoverQuery.isError ? (
        <output
          className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full bg-orange-700/90 px-3 py-1 text-xs text-white"
          data-testid="discover-error"
        >
          Nearby places unavailable right now — your saved pins are unaffected
        </output>
      ) : null}
      {!idle && !readOnly && pickerAt ? (
        <CandidatePicker
          lat={pickerAt.lat}
          lng={pickerAt.lng}
          onSelect={(poi) => {
            closePicker();
            selectOsm(poi.osmRef, {
              ...(poi.name ? { name: poi.name } : {}),
              lat: poi.lat,
              lng: poi.lng,
              category: poi.category,
            });
          }}
          onClose={closePicker}
          onSaveManual={(pos) => {
            closePicker();
            setManualAt(pos);
          }}
        />
      ) : null}
      {!idle && !readOnly && manualAt ? (
        <ManualPinDialog
          lat={manualAt.lat}
          lng={manualAt.lng}
          lists={lists}
          onSave={(facts, listTarget) => {
            setManualAt(null);
            void (async () => {
              let listId: string;
              if (listTarget.kind === "new") {
                listId = newId();
                await repo.createList({
                  id: listId,
                  name: listTarget.name,
                  marker: listTarget.marker,
                  createdAt: nowIso(),
                  updatedAt: nowIso(),
                });
              } else {
                listId = listTarget.listId;
              }
              const view = await repo.addToList(listId, { kind: "manual", facts }, nowIso());
              selectPlace(view.place.id);
            })();
          }}
          onCancel={() => setManualAt(null)}
        />
      ) : null}
    </div>
  );
}
