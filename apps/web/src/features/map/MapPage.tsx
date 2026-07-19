import type { BBox, ResolvedPoi } from "@placemarks/domain";
import { displayFacts, refKey } from "@placemarks/domain";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DISCOVER_MIN_ZOOM, MAP_STYLE_URL } from "../../config";
import { useLibraryPlaces, useListMembership, useLists } from "../../data/hooks";
import { useDexieRepo, useRepo } from "../../data/RepoContext";
import { newId } from "../../lib/id";
import { pinColorForLists } from "../../lib/markers";
import { nowIso } from "../../lib/time";
import { initialViewport, persistViewport } from "../../lib/viewport";
import { MapView, type PlacePinFeature, type PoiPinFeature } from "../../map/MapView";
import { poiResolver, searchProvider } from "../../providers";
import { useUiStore } from "../../state/ui";
import { resolveReviewItem } from "../interop/importer";
import { CandidatePicker } from "../picker/CandidatePicker";
import { ManualPinDialog } from "../picker/ManualPinDialog";
import { PlaceSheet } from "../place/PlaceSheet";
import { SearchBar } from "../search/SearchBar";
import { TOP_CATEGORIES, type TopCategory, topCategoryOf } from "./categories";

interface Viewport {
  bbox: BBox;
  zoom: number;
}

function roundBbox(bbox: BBox): string {
  return [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(4)).join(",");
}

export function MapPage() {
  const repo = useRepo();
  const dexieRepo = useDexieRepo();
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

  const libraryPlaces = useLibraryPlaces();
  const lists = useLists();
  const membership = useListMembership();
  const [manualAt, setManualAt] = useState<{ lat: number; lng: number } | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  // Active top-level category chips; none active shows everything.
  const [activeFilters, setActiveFilters] = useState<ReadonlySet<TopCategory>>(new Set());
  // The starting camera: last viewport, else a timezone-derived approximation
  // (book/src/map-view.md — no permission prompt, nothing leaves the device).
  const [startViewport] = useState(() => initialViewport());
  const discoverEnabled = viewport !== null && viewport.zoom >= DISCOVER_MIN_ZOOM;

  // Bounded, debounced viewport POI discovery (book/src/data-sources.md budgets).
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

  const listsById = new Map((lists ?? []).map((l) => [l.id, l]));
  const placePins: PlacePinFeature[] = (libraryPlaces ?? []).flatMap((view) => {
    const facts = displayFacts(view.place);
    if (!facts) return [];
    const memberLists = (membership?.[view.place.id] ?? [])
      .map((id) => listsById.get(id))
      .filter((l): l is NonNullable<typeof l> => l !== undefined);
    return [
      {
        placeId: view.place.id,
        name: facts.name ?? "Place",
        lat: facts.lat,
        lng: facts.lng,
        // Only deliberate manual pins keep the distinct orange marker; an
        // imported-but-unlinked place wears its list colour like any other.
        unlinked: view.place.resolutionState === "unlinked" && view.place.origin === "manual",
        color: pinColorForLists(memberLists),
      },
    ];
  });

  // The selection is marked on the map immediately, listed or not.
  const selectionPin =
    selection?.kind === "osm" && selection.hint
      ? { lat: selection.hint.lat, lng: selection.hint.lng }
      : selection?.kind === "place"
        ? (() => {
            const view = (libraryPlaces ?? []).find((v) => v.place.id === selection.placeId);
            const facts = view ? displayFacts(view.place) : undefined;
            return facts ? { lat: facts.lat, lng: facts.lng } : null;
          })()
        : null;

  return (
    <div className="relative h-full" data-testid="map-page">
      <MapView
        styleUrl={MAP_STYLE_URL}
        initialCenter={{ lat: startViewport.lat, lng: startViewport.lng }}
        initialZoom={startViewport.zoom}
        placePins={placePins}
        poiPins={poiPins}
        selectionPin={selectionPin}
        flyTo={flyTo}
        onSelectPlace={selectPlace}
        onSelectPoi={(pin) =>
          selectOsm(pin.ref, { name: pin.name, lat: pin.lat, lng: pin.lng, category: pin.category })
        }
        onLongPress={(pos) => {
          // Placing a review-queue import item: the long-press IS the placement.
          if (placingImportItemId) {
            const itemId = placingImportItemId;
            stopPlacingImportItem();
            void (async () => {
              const item = await dexieRepo.db.importItems.get(itemId);
              await resolveReviewItem(
                dexieRepo,
                { search: searchProvider, resolver: poiResolver },
                itemId,
                { kind: "coords", lat: pos.lat, lng: pos.lng },
                nowIso(),
              );
              const placed = item ? await dexieRepo.db.importItems.get(itemId) : undefined;
              if (placed?.placeId) selectPlace(placed.placeId);
            })();
            return;
          }
          openPicker(pos);
        }}
        onViewportChange={(view) => {
          setViewport(view);
          // The next launch starts where this session left off — coarsened to
          // a ~1 km grid so a Locate-driven recenter never persists a precise
          // position (book/src/map-view.md: nothing precise leaves the session).
          const coarse = (value: number) => Math.round(value * 100) / 100;
          persistViewport({
            lat: coarse(view.center.lat),
            lng: coarse(view.center.lng),
            zoom: view.zoom,
          });
        }}
      />
      {placingImportItemId ? (
        <output
          className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full bg-orange-700/90 px-3 py-1 text-xs text-white"
          data-testid="placing-import-hint"
        >
          Long-press (or right-click) the map to place the imported item
        </output>
      ) : null}
      {/* Category chips (book/src/map-view.md): keyboard-operable toggles. */}
      <fieldset
        className="absolute top-16 left-1/2 z-10 flex w-[calc(100%-1.5rem)] min-w-0 max-w-md -translate-x-1/2 flex-wrap gap-1.5"
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
      {/* The synchronized non-map equivalent of canvas results
          (book/src/map-view.md §Accessibility): every discovered POI is
          reachable by keyboard and screen reader. */}
      {poiPins.length > 0 ? (
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
      <div className="absolute top-3 left-1/2 z-10 w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2">
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
      {viewport && !discoverEnabled ? (
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
      {selection ? <PlaceSheet /> : null}
      {pickerAt ? (
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
      {manualAt ? (
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
                  color: listTarget.color,
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
