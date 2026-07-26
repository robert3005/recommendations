/**
 * The persistent map canvas (spec/src/map-view.md §The grammar): a singleton
 * in the app shell, outside the route outlet — it never navigates; it
 * re-projects whatever the pane shows. Owns the floating canvas chrome
 * (search, the list-toggles row — the primary filter, an explicit "Show
 * nearby" request, hints, the accessible nearby list) and the map-borne
 * dialogs (place sheet, candidate picker, manual pin). While the pane fully
 * occludes it the canvas idles, applying nothing until reveal.
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
import { CandidatePicker } from "../features/picker/CandidatePicker";
import { ManualPinDialog } from "../features/picker/ManualPinDialog";
import { SearchBar } from "../features/search/SearchBar";
import { newId } from "../lib/id";
import { nowIso } from "../lib/time";
import { initialViewport, persistViewport } from "../lib/viewport";
import { mapStyleProvider, poiResolver, searchProvider } from "../providers";
import { usePaneStore } from "../state/pane";
import { useProjectionStore } from "../state/projection";
import { useUiStore } from "../state/ui";
import { MapView, type MarkPinFeature, type PlacePinFeature, type PoiPinFeature } from "./MapView";
import { fitForProjection, libraryPins } from "./projectionPins";

interface Viewport {
  bbox: BBox;
  zoom: number;
}

function roundBbox(bbox: BBox): string {
  return [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(4)).join(",");
}

export interface MapCanvasProps {
  readOnly?: boolean;
}

export function MapCanvas({ readOnly = false }: MapCanvasProps) {
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
  /**
   * Nearby places is an explicit, one-shot request — OFF by default.
   *
   * Ambient discovery (fetch on every pan, filter with a category taxonomy) is
   * the pre-pivot front door: "find every place again through our own map",
   * which the interop pivot rejected because OSM search quality trails Google's
   * in many regions. It was also the only thing giving the canvas a standing
   * network appetite, and therefore the only reason a hidden map needed to be
   * forcibly quietened. Asking is cheap; asking on every pan was not.
   *
   * Cleared on pan, so the answer never silently belongs to a different place.
   */
  const [showNearby, setShowNearby] = useState(false);
  // The starting camera: the last viewport, else a timezone-derived
  // approximation (spec/src/map-view.md — no permission prompt, nothing leaves
  // the device). There is no URL camera: it duplicated this, and forced a
  // hand-ranked three-way arbitration against fly-to and fit-to.
  const [startViewport] = useState(() => initialViewport());
  const privateMapProjection =
    projection.kind === "all" || projection.kind === "list" || projection.kind === "post";
  const interactiveChrome = privateMapProjection && !readOnly && !idle;
  const nearbyEligible =
    interactiveChrome && viewport !== null && viewport.zoom >= DISCOVER_MIN_ZOOM;
  const discoverEnabled = nearbyEligible && showNearby;

  // `enabled: false` does not cancel a request which was already running.
  // Full occlusion explicitly aborts the query's signal; unmounting search
  // below likewise cancels its now-unobserved request.
  useEffect(() => {
    if (idle || readOnly || !privateMapProjection) {
      void queryClient.cancelQueries({ queryKey: ["discover"] });
    }
  }, [idle, privateMapProjection, queryClient, readOnly]);

  // A pan makes the previous answer stale by definition: drop it rather than
  // keep pins for somewhere the user is no longer looking.
  const nearbyBboxKey = viewport ? roundBbox(viewport.bbox) : "";
  const nearbyAskedFor = useRef(nearbyBboxKey);
  useEffect(() => {
    if (nearbyAskedFor.current === nearbyBboxKey) return;
    nearbyAskedFor.current = nearbyBboxKey;
    setShowNearby(false);
  }, [nearbyBboxKey]);

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

  const poiPins: PoiPinFeature[] = discoverEnabled
    ? (discoverQuery.data?.pois ?? []).map((poi: ResolvedPoi) => ({
        refKey: refKey(poi.osmRef),
        ref: poi.osmRef,
        name: poi.name ?? "Unnamed",
        category: poi.category,
        lat: poi.lat,
        lng: poi.lng,
      }))
    : [];

  // ---- The projection: which library places show, and which are dimmed ----
  const _listsById = new Map((lists ?? []).map((l) => [l.id, l]));
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
      : libraryPins({
          projection,
          places: libraryPlaces ?? [],
          membership: membership ?? {},
          lists: lists ?? [],
          hiddenListIds,
          ...(post ? { postListId: post.listId } : {}),
          ...(focusPlaceIds ? { focusPlaceIds } : {}),
          ...(postCandidateIds ? { candidatePlaceIds: postCandidateIds } : {}),
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
  const fitTo = fitForProjection({
    projection,
    placePins,
    markPins,
    ...(reviewItem ? { reviewItemId: reviewItem.id } : {}),
  });

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
        }}
      />
      {!idle && !readOnly && placingImportItemId ? (
        <div
          role="status"
          className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full bg-clay-ink/90 px-3 py-1 text-xs text-white"
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
                className={`rounded-full bg-paper/95 p-0.5 shadow ${hidden ? "opacity-40" : ""}`}
              >
                <MarkerGlyph marker={list.marker} size={22} />
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
          className="absolute bottom-16 left-3 z-10 max-h-40 w-56 overflow-y-auto rounded-lg bg-paper/95 p-1.5 text-xs shadow"
        >
          <ul>
            {poiPins.map((pin) => (
              <li key={pin.refKey}>
                <button
                  type="button"
                  className="w-full rounded px-1.5 py-1 text-left hover:bg-land"
                  onClick={() =>
                    selectOsm(pin.ref, {
                      name: pin.name,
                      lat: pin.lat,
                      lng: pin.lng,
                      category: pin.category,
                    })
                  }
                >
                  <span className="font-medium text-ink">{pin.name}</span>{" "}
                  <span className="text-ink-3">({pin.category})</span>
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
            aria-pressed={showNearby}
            disabled={!nearbyEligible}
            data-testid="show-nearby-places"
            onClick={() => setShowNearby((on) => !on)}
            className={`shrink-0 rounded-full px-2.5 py-1.5 text-xs font-medium shadow disabled:opacity-40 ${
              showNearby ? "bg-ink text-white" : "bg-paper/95 text-ink-2"
            }`}
          >
            {showNearby ? "Hide nearby" : "Show nearby"}
          </button>
        </div>
      ) : null}
      {interactiveChrome && viewport && !nearbyEligible ? (
        <div className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full bg-ink/85 px-3 py-1 text-xs text-white">
          Zoom in to see nearby places
        </div>
      ) : null}
      {discoverEnabled && discoverQuery.data?.truncated ? (
        <div className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full bg-ink/85 px-3 py-1 text-xs text-white">
          Showing a capped set of places — zoom in for more
        </div>
      ) : null}
      {discoverEnabled && discoverQuery.isError ? (
        <output
          className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full bg-clay-ink/90 px-3 py-1 text-xs text-white"
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
