import type { BBox, ResolvedPoi } from "@placemarks/domain";
import { refKey } from "@placemarks/domain";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DISCOVER_MIN_ZOOM, MAP_STYLE_URL } from "../../config";
import { MapView, type PoiPinFeature } from "../../map/MapView";
import { poiResolver } from "../../providers";
import { useUiStore } from "../../state/ui";
import { CandidatePicker } from "../picker/CandidatePicker";
import { PlaceSheet } from "../place/PlaceSheet";
import { SearchBar } from "../search/SearchBar";

interface Viewport {
  bbox: BBox;
  zoom: number;
}

function roundBbox(bbox: BBox): string {
  return [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(4)).join(",");
}

export function MapPage() {
  const selection = useUiStore((s) => s.selection);
  const flyTo = useUiStore((s) => s.flyTo);
  const pickerAt = useUiStore((s) => s.pickerAt);
  const selectOsm = useUiStore((s) => s.selectOsm);
  const openPicker = useUiStore((s) => s.openPicker);
  const closePicker = useUiStore((s) => s.closePicker);
  const requestFlyTo = useUiStore((s) => s.requestFlyTo);

  const [viewport, setViewport] = useState<Viewport | null>(null);
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

  return (
    <div className="relative h-full" data-testid="map-page">
      <MapView
        styleUrl={MAP_STYLE_URL}
        savedPins={[]}
        poiPins={poiPins}
        flyTo={flyTo}
        onSelectPoi={(pin) =>
          selectOsm(pin.ref, { name: pin.name, lat: pin.lat, lng: pin.lng, category: pin.category })
        }
        onLongPress={(pos) => openPicker(pos)}
        onViewportChange={(view) => setViewport(view)}
      />
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
      {discoverEnabled && discoverQuery.data?.truncated ? (
        <div className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full bg-stone-800/85 px-3 py-1 text-xs text-white">
          Showing a capped set of places — zoom in for more
        </div>
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
        />
      ) : null}
    </div>
  );
}
