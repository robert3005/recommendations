/**
 * Thin MapLibre adapter (book/src/tech-stack.md: no wrapper library — we own this boundary).
 * Renders the basemap with required OSM attribution, saved pins (clustered), transient
 * viewport POIs, and reports gestures upward. No domain logic lives here.
 */
import type { BBox, OsmElementRef } from "@placemarks/domain";
import type { FeatureCollection } from "geojson";
import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { DISCOVER_DEBOUNCE_MS, OSM_ATTRIBUTION } from "../config";

export interface PlacePinFeature {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  unlinked: boolean;
  /** List marker colour (or the default) — book/src/map-view.md. */
  color: string;
}

export interface PoiPinFeature {
  refKey: string;
  ref: OsmElementRef;
  name: string;
  category: string;
  lat: number;
  lng: number;
}

export interface MapViewProps {
  styleUrl: string;
  placePins: PlacePinFeature[];
  poiPins: PoiPinFeature[];
  /** The currently selected place — marked immediately with a ring. */
  selectionPin?: { lat: number; lng: number } | null;
  flyTo?: { lat: number; lng: number; zoom?: number } | null;
  onSelectPlace?: (placeId: string) => void;
  onSelectPoi?: (poi: PoiPinFeature) => void;
  onLongPress?: (pos: { lat: number; lng: number }) => void;
  onViewportChange?: (view: { bbox: BBox; zoom: number }) => void;
}

const LONG_PRESS_MS = 600;
const LONG_PRESS_TOLERANCE_PX = 8;

function placesToGeoJSON(pins: PlacePinFeature[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
      properties: {
        placeId: pin.placeId,
        name: pin.name,
        unlinked: pin.unlinked ? 1 : 0,
        color: pin.color,
      },
    })),
  };
}

function poisToGeoJSON(pins: PoiPinFeature[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
      properties: { refKey: pin.refKey, name: pin.name, category: pin.category },
    })),
  };
}

export function MapView({
  styleUrl,
  placePins,
  poiPins,
  selectionPin,
  flyTo,
  onSelectPlace,
  onSelectPoi,
  onLongPress,
  onViewportChange,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const callbacksRef = useRef({ onSelectPlace, onSelectPoi, onLongPress, onViewportChange });
  callbacksRef.current = { onSelectPlace, onSelectPoi, onLongPress, onViewportChange };
  const poiPinsRef = useRef(poiPins);
  poiPinsRef.current = poiPins;
  // A basemap that never establishes itself is a designed state, not a blank
  // canvas (book/src/map-view.md §Offline and failure states).
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      center: [-9.1394, 38.7139],
      zoom: 2,
      attributionControl: false,
    });
    mapRef.current = map;

    // OSM attribution is a licensing requirement on every map surface.
    map.addControl(
      new maplibregl.AttributionControl({ compact: false, customAttribution: OSM_ATTRIBUTION }),
    );
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    // Geolocation is user-triggered; denial/timeout must never block the map (Phase 0).
    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 8000 },
      trackUserLocation: false,
      showUserLocation: true,
    });
    map.addControl(geolocate, "top-right");
    geolocate.on("error", () => {
      // Designed state, not a blank screen: the map stays fully usable without location.
    });

    // Observable view state for tests and debugging (canvas pixels are not inspectable
    // without preserveDrawingBuffer, which costs performance).
    const container = containerRef.current;
    const updateViewData = () => {
      if (!container) return;
      const center = map.getCenter();
      container.dataset.center = `${center.lng.toFixed(4)},${center.lat.toFixed(4)}`;
      container.dataset.zoom = map.getZoom().toFixed(2);
    };
    map.on("move", updateViewData);
    updateViewData();

    // A style/tile failure before the basemap ever loads means there is no map to
    // show; errors after load degrade tile-by-tile and stay silent here.
    let styleLoaded = false;
    map.on("error", () => {
      if (!styleLoaded) setUnavailable(true);
    });

    map.on("load", () => {
      styleLoaded = true;
      setUnavailable(false);
      map.addSource("pois", { type: "geojson", data: poisToGeoJSON([]) });
      map.addLayer({
        id: "poi-pins",
        type: "circle",
        source: "pois",
        paint: {
          // Live POIs are visually secondary to saved pins.
          "circle-color": "#57534e",
          "circle-radius": 5,
          "circle-opacity": 0.75,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#fafaf9",
        },
      });
      map.addSource("saved", {
        type: "geojson",
        data: placesToGeoJSON([]),
        cluster: true,
        clusterRadius: 44,
      });
      map.addLayer({
        id: "saved-clusters",
        type: "circle",
        source: "saved",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#1c1917",
          "circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 50, 24],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fafaf9",
        },
      });
      map.addLayer({
        id: "saved-cluster-count",
        type: "symbol",
        source: "saved",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
        },
        paint: { "text-color": "#fafaf9" },
      });
      map.addLayer({
        id: "saved-pins",
        type: "circle",
        source: "saved",
        filter: ["!", ["has", "point_count"]],
        paint: {
          // Unlinked manual pins keep their marker; others wear their list colour.
          "circle-color": ["case", ["==", ["get", "unlinked"], 1], "#b45309", ["get", "color"]],
          "circle-radius": 8,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fafaf9",
        },
      });

      map.addSource("selection", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "selection-ring",
        type: "circle",
        source: "selection",
        paint: {
          "circle-radius": 11,
          "circle-color": "#000000",
          "circle-opacity": 0,
          "circle-stroke-width": 3,
          "circle-stroke-color": "#1c1917",
        },
      });

      map.on("click", "saved-pins", (e) => {
        const feature = e.features?.[0];
        const id = feature?.properties?.placeId as string | undefined;
        if (id) callbacksRef.current.onSelectPlace?.(id);
      });
      map.on("click", "saved-clusters", async (e) => {
        const feature = e.features?.[0];
        const clusterId = feature?.properties?.cluster_id as number | undefined;
        const source = map.getSource("saved") as maplibregl.GeoJSONSource | undefined;
        if (clusterId === undefined || !source || feature?.geometry.type !== "Point") return;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        map.easeTo({ center: feature.geometry.coordinates as [number, number], zoom });
      });
      map.on("click", "poi-pins", (e) => {
        const refKeyProp = e.features?.[0]?.properties?.refKey as string | undefined;
        const pin = poiPinsRef.current.find((p) => p.refKey === refKeyProp);
        if (pin) callbacksRef.current.onSelectPoi?.(pin);
      });
      for (const layer of ["saved-pins", "saved-clusters", "poi-pins"]) {
        map.on("mouseenter", layer, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }
    });

    // Long press (touch) and right-click both open the nearby-candidate flow.
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let pressStart: { x: number; y: number } | null = null;
    const clearPress = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = undefined;
      pressStart = null;
    };
    map.on("touchstart", (e) => {
      if (e.points.length !== 1) return clearPress();
      const point = e.points[0];
      if (!point) return;
      pressStart = { x: point.x, y: point.y };
      const lngLat = e.lngLat;
      pressTimer = setTimeout(() => {
        callbacksRef.current.onLongPress?.({ lat: lngLat.lat, lng: lngLat.lng });
        clearPress();
      }, LONG_PRESS_MS);
    });
    map.on("touchmove", (e) => {
      const point = e.points[0];
      if (!pressStart || !point) return;
      const moved = Math.hypot(point.x - pressStart.x, point.y - pressStart.y);
      if (moved > LONG_PRESS_TOLERANCE_PX) clearPress();
    });
    map.on("touchend", clearPress);
    map.on("contextmenu", (e) => {
      callbacksRef.current.onLongPress?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    // Debounced viewport reporting for bounded POI discovery.
    let moveTimer: ReturnType<typeof setTimeout> | undefined;
    map.on("moveend", () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        const bounds = map.getBounds();
        callbacksRef.current.onViewportChange?.({
          bbox: {
            west: bounds.getWest(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            north: bounds.getNorth(),
          },
          zoom: map.getZoom(),
        });
      }, DISCOVER_DEBOUNCE_MS);
    });

    return () => {
      clearPress();
      if (moveTimer) clearTimeout(moveTimer);
      map.remove();
      mapRef.current = null;
    };
  }, [styleUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      (map.getSource("saved") as maplibregl.GeoJSONSource | undefined)?.setData(
        placesToGeoJSON(placePins),
      );
      // Observable render state: the count appears only after the layer has
      // actually painted (tests wait on this instead of sleeping).
      map.once("idle", () => {
        if (containerRef.current) {
          containerRef.current.dataset.pins = String(placePins.length);
        }
      });
    };
    if (map.getSource("saved")) apply();
    else map.once("load", apply);
  }, [placePins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      (map.getSource("pois") as maplibregl.GeoJSONSource | undefined)?.setData(
        poisToGeoJSON(poiPins),
      );
    };
    if (map.getSource("pois")) apply();
    else map.once("load", apply);
  }, [poiPins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const source = map.getSource("selection") as maplibregl.GeoJSONSource | undefined;
      source?.setData({
        type: "FeatureCollection",
        features: selectionPin
          ? [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: [selectionPin.lng, selectionPin.lat] },
                properties: {},
              },
            ]
          : [],
      });
      if (containerRef.current) {
        containerRef.current.dataset.selection = selectionPin ? "1" : "0";
      }
    };
    if (map.getSource("selection")) apply();
    else map.once("load", apply);
  }, [selectionPin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo) return;
    map.flyTo({
      center: [flyTo.lng, flyTo.lat],
      zoom: flyTo.zoom ?? 17,
      duration: 700,
      // Keep the target clear of the bottom sheet.
      offset: [0, -120],
    });
  }, [flyTo]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} data-testid="map-canvas" className="h-full w-full" />
      {unavailable ? (
        <div
          role="status"
          className="absolute inset-0 z-10 flex items-center justify-center bg-stone-100 p-6"
        >
          <p className="max-w-sm text-center text-sm text-stone-600">
            <span className="font-semibold text-stone-800">Map unavailable.</span> The map style
            could not load. Search and your lists keep working — the map returns when the connection
            does.
          </p>
        </div>
      ) : null}
    </div>
  );
}
