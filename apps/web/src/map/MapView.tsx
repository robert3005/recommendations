/**
 * Thin MapLibre adapter (spec/src/tech-stack.md: no wrapper library — we own
 * this boundary). Renders the basemap with required OSM attribution, library
 * pins wearing their list's (colour, icon) marker (clustered), transient
 * viewport POIs, labelled review-candidate marks, and reports gestures
 * upward. No domain logic lives here.
 */
import type { BBox, OsmElementRef } from "@placemarks/domain";
import type { FeatureCollection } from "geojson";
import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { OSM_ATTRIBUTION, VIEWPORT_DEBOUNCE_MS } from "../config";
import { MARKER_ICON_PATHS, MULTI_LIST_PIN_COLOR } from "../lib/markers";

export interface PlacePinFeature {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  /** List marker colour (deterministic first list when in several). */
  color: string;
  /** List marker icon id (spec/src/map-view.md: pins wear icon + colour). */
  icon: string;
  /** An unlinked pin wears its list's marker with a small "not linked" dot. */
  unlinked: boolean;
  /** In several lists: the deterministic stacked/badged variant. */
  multi: boolean;
  /** Outside the current projection's focus: rendered dimmed. */
  dimmed: boolean;
}

export interface PoiPinFeature {
  refKey: string;
  ref: OsmElementRef;
  name: string;
  category: string;
  lat: number;
  lng: number;
}

/** A labelled transient mark — review-queue candidates (A, B, C…). */
export interface MarkPinFeature {
  key: string;
  name: string;
  label: string;
  lat: number;
  lng: number;
  /** Public manual anchors carry an explicit unlinked map label. */
  unlinked?: boolean;
}

export interface MapViewProps {
  styleUrl: string;
  /** Fully occluded: retain the scene, but suspend rendering and tile work. */
  idle?: boolean;
  /** Changes when shell geometry changes so MapLibre remeasures its canvas. */
  layoutKey?: string;
  /** Starting camera — the caller decides (last viewport / timezone approximation). */
  initialCenter: { lat: number; lng: number };
  initialZoom: number;
  /** A typed URL camera restored after back/forward without remounting. */
  placePins: PlacePinFeature[];
  poiPins: PoiPinFeature[];
  markPins?: MarkPinFeature[];
  /** The currently selected place — marked immediately with a ring. */
  selectionPin?: { lat: number; lng: number } | null;
  flyTo?: { lat: number; lng: number; zoom?: number } | null;
  /**
   * One camera move to frame a projection (route change / reveal after
   * idling). `key` de-duplicates: the move applies once per distinct key.
   */
  fitTo?: { bounds: BBox; key: string } | null;
  onSelectPlace?: (placeId: string) => void;
  onSelectPoi?: (poi: PoiPinFeature) => void;
  onSelectMark?: (mark: MarkPinFeature) => void;
  onLongPress?: (pos: { lat: number; lng: number }) => void;
  onViewportChange?: (view: {
    bbox: BBox;
    zoom: number;
    center: { lat: number; lng: number };
  }) => void;
}

/**
 * Our own GeoJSON sources. Exported because two places must agree about them:
 * the layer setup that creates them, and the basemap-recovery guard that must
 * NOT treat their data events as evidence the basemap came back. Two
 * hand-maintained copies of this list silently drift.
 */
export const OUR_SOURCE_IDS = ["pois", "saved", "marks", "selection"] as const;

const LONG_PRESS_MS = 600;
const LONG_PRESS_TOLERANCE_PX = 8;

/** Sprite id for a marker variant — parsed back by the sprite painter. */
function markerImageId(pin: PlacePinFeature): string {
  return `pm|${pin.color}|${pin.icon}|${pin.unlinked ? "u" : "-"}|${pin.multi ? "m" : "-"}`;
}

/**
 * Paint a marker sprite: the icon glyph in white on the colour disc, a grey
 * "not linked" dot, a dark "+" badge for the multi-list variant — the same
 * look MarkerGlyph renders in the DOM.
 */
function paintMarkerImage(id: string): ImageData | undefined {
  const [, color = "#888888", icon = "circle", unlinked = "-", multi = "-"] = id.split("|");
  const size = 44; // 2× for retina; icon-size 0.5 in the layer
  if (typeof document === "undefined" || typeof Path2D === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  const center = size / 2;
  const radius = size * 0.36;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fillStyle = multi === "m" ? MULTI_LIST_PIN_COLOR : color;
  ctx.fill();
  ctx.lineWidth = size * 0.06;
  ctx.strokeStyle = "#fafaf9";
  ctx.stroke();
  // The glyph path data is authored on a 24×24 viewBox.
  const path = new Path2D(MARKER_ICON_PATHS[icon] ?? MARKER_ICON_PATHS.circle ?? "");
  const glyphScale = (radius * 1.24) / 24;
  ctx.save();
  ctx.translate(center - 12 * glyphScale, center - 12 * glyphScale);
  ctx.scale(glyphScale, glyphScale);
  ctx.fillStyle = "#fafaf9";
  ctx.fill(path);
  ctx.restore();
  if (multi === "m") {
    // The stacked/badged variant: a small "+" badge at the top right.
    ctx.beginPath();
    ctx.arc(center + radius * 0.85, center - radius * 0.85, size * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = "#fafaf9";
    ctx.fill();
    ctx.fillStyle = "#1c1917";
    ctx.font = `bold ${(size * 0.22).toString()}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("+", center + radius * 0.85, center - radius * 0.82);
  }
  if (unlinked === "u") {
    // The small "not linked" dot (supersedes the distinct orange marker).
    ctx.beginPath();
    ctx.arc(center + radius * 0.85, center + radius * 0.85, size * 0.11, 0, Math.PI * 2);
    ctx.fillStyle = "#78716c";
    ctx.fill();
    ctx.lineWidth = size * 0.03;
    ctx.strokeStyle = "#fafaf9";
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, size, size);
}

function placesToGeoJSON(pins: PlacePinFeature[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
      properties: {
        placeId: pin.placeId,
        name: pin.name,
        iconId: markerImageId(pin),
        dimmed: pin.dimmed ? 1 : 0,
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

function marksToGeoJSON(pins: MarkPinFeature[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
      properties: {
        key: pin.key,
        name: pin.name,
        label: pin.label,
        unlinked: pin.unlinked ? 1 : 0,
      },
    })),
  };
}

export function MapView({
  styleUrl,
  idle = false,
  layoutKey,
  initialCenter,
  initialZoom,
  placePins,
  poiPins,
  markPins = [],
  selectionPin,
  flyTo,
  fitTo,
  onSelectPlace,
  onSelectPoi,
  onSelectMark,
  onLongPress,
  onViewportChange,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const wasIdleRef = useRef(idle);
  const providerStyleActivatedRef = useRef(!idle);
  const appliedStyleUrlRef = useRef<string | undefined>(undefined);
  const callbacksRef = useRef({
    onSelectPlace,
    onSelectPoi,
    onSelectMark,
    onLongPress,
    onViewportChange,
  });
  callbacksRef.current = {
    onSelectPlace,
    onSelectPoi,
    onSelectMark,
    onLongPress,
    onViewportChange,
  };
  const poiPinsRef = useRef(poiPins);
  poiPinsRef.current = poiPins;
  const placePinsRef = useRef(placePins);
  placePinsRef.current = placePins;
  const markPinsRef = useRef(markPins);
  markPinsRef.current = markPins;
  const selectionPinRef = useRef(selectionPin);
  selectionPinRef.current = selectionPin;
  // A basemap that never establishes itself is a designed state, not a blank
  // canvas (spec/src/map-view.md §Offline and failure states).
  const [unavailable, setUnavailable] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the initial camera/style apply once at singleton creation; later style changes reconcile below without recreating the map.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    providerStyleActivatedRef.current = !idleRef.current;
    appliedStyleUrlRef.current = providerStyleActivatedRef.current ? styleUrl : undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      ...(providerStyleActivatedRef.current ? { style: styleUrl } : {}),
      center: [initialCenter.lng, initialCenter.lat],
      zoom: initialZoom,
      attributionControl: false,
    });
    mapRef.current = map;

    // OSM attribution is a licensing requirement on every map surface.
    map.addControl(
      new maplibregl.AttributionControl({
        compact: false,
      }),
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

    // Marker sprites are painted on demand — every (colour, icon, dot, badge)
    // variant materializes the first time a pin wears it.
    map.on("styleimagemissing", (event: { id: string }) => {
      if (!event.id.startsWith("pm|") || map.hasImage(event.id)) return;
      const image = paintMarkerImage(event.id);
      if (image) map.addImage(event.id, image, { pixelRatio: 2 });
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

    // Any basemap failure — before or after the style loaded — surfaces the
    // designed unavailable state. Clearing requires positive evidence of
    // recovery (successful data traffic), never merely a failed request cycle
    // going idle.
    map.on("error", () => {
      setUnavailable(true);
    });
    map.on("data", (event) => {
      // Only BASEMAP traffic is recovery evidence — our own local GeoJSON
      // sources load fine while the basemap is down, and a source's request
      // cycle merely going idle is not successful traffic.
      const { sourceId, sourceDataType } = event as {
        sourceId?: string;
        sourceDataType?: string;
      };
      if (OUR_SOURCE_IDS.includes(sourceId as (typeof OUR_SOURCE_IDS)[number])) return;
      if (sourceDataType === "idle") return;
      setUnavailable(false);
    });

    map.on("load", () => {
      // The no-style launch exists only to mount the retained canvas.
      // Projection sources are installed when the real provider style loads.
      if (!providerStyleActivatedRef.current) return;
      setUnavailable(false);
      map.addSource("pois", { type: "geojson", data: poisToGeoJSON(poiPinsRef.current) });
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
        data: placesToGeoJSON(placePinsRef.current),
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
      // Library pins wear their list's unique marker (icon + colour) —
      // spec/src/map-view.md §Core interactions; dimmed outside the current
      // projection's focus.
      map.addLayer({
        id: "saved-pins",
        type: "symbol",
        source: "saved",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": ["get", "iconId"],
          "icon-size": 0.5,
          "icon-allow-overlap": true,
        },
        paint: {
          "icon-opacity": ["case", ["==", ["get", "dimmed"], 1], 0.35, 1],
        },
      });

      // Labelled transient marks (review-queue candidates: A, B, C…).
      map.addSource("marks", { type: "geojson", data: marksToGeoJSON(markPinsRef.current) });
      map.addLayer({
        id: "mark-pins",
        type: "circle",
        source: "marks",
        paint: {
          "circle-color": ["case", ["==", ["get", "unlinked"], 1], "#57534e", "#9a3412"],
          "circle-radius": 10,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fafaf9",
        },
      });
      map.addLayer({
        id: "mark-labels",
        type: "symbol",
        source: "marks",
        layout: { "text-field": ["get", "label"], "text-size": 11 },
        paint: { "text-color": "#fafaf9" },
      });
      map.addLayer({
        id: "mark-unlinked-labels",
        type: "symbol",
        source: "marks",
        filter: ["==", ["get", "unlinked"], 1],
        layout: {
          "text-field": "not linked",
          "text-size": 9,
          "text-offset": [0, 1.8],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#44403c",
          "text-halo-color": "#fafaf9",
          "text-halo-width": 1.5,
        },
      });

      map.addSource("selection", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: selectionPinRef.current
            ? [
                {
                  type: "Feature",
                  geometry: {
                    type: "Point",
                    coordinates: [selectionPinRef.current.lng, selectionPinRef.current.lat],
                  },
                  properties: {},
                },
              ]
            : [],
        },
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
      if (container) {
        container.dataset.pins = String(placePinsRef.current.length);
        container.dataset.marks = String(markPinsRef.current.length);
        container.dataset.selection = selectionPinRef.current ? "1" : "0";
      }

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
      map.on("click", "mark-pins", (e) => {
        const keyProp = e.features?.[0]?.properties?.key as string | undefined;
        const mark = markPinsRef.current.find((m) => m.key === keyProp);
        if (mark) callbacksRef.current.onSelectMark?.(mark);
      });
      for (const layer of ["saved-pins", "saved-clusters", "poi-pins", "mark-pins"]) {
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
      if (idleRef.current) return;
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (idleRef.current) return;
        const bounds = map.getBounds();
        const center = map.getCenter();
        callbacksRef.current.onViewportChange?.({
          bbox: {
            west: bounds.getWest(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            north: bounds.getNorth(),
          },
          zoom: map.getZoom(),
          center: { lat: center.lat, lng: center.lng },
        });
      }, VIEWPORT_DEBOUNCE_MS);
    });

    return () => {
      clearPress();
      if (moveTimer) clearTimeout(moveTimer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      wasIdleRef.current = idle;
      return;
    }
    if (idle) {
      // `stop()` ends animations and pending easing. Everything else that used
      // to be forced here — aborting the frame request, clearing the render
      // task queue, pausing every tile manager, aborting in-flight tiles — was
      // reaching into MapLibre's private fields to duplicate what the browser
      // already does for a hidden element, against a caret-ranged dependency.
      // What actually keeps a hidden canvas off the network is the `if (idle)
      // return` guards on the projection effects below, plus never activating
      // the provider style until first reveal.
      map.stop();
      if (containerRef.current) containerRef.current.dataset.idle = "1";
      wasIdleRef.current = true;
      return;
    }
    if (!providerStyleActivatedRef.current || appliedStyleUrlRef.current !== styleUrl) {
      providerStyleActivatedRef.current = true;
      appliedStyleUrlRef.current = styleUrl;
      map.setStyle(styleUrl);
    }
    if (!wasIdleRef.current) {
      if (containerRef.current) containerRef.current.dataset.idle = "0";
      return;
    }
    // Revealed: the box changed while hidden, so remeasure and paint once.
    map.resize();
    map.triggerRepaint();
    if (containerRef.current) containerRef.current.dataset.idle = "0";
    wasIdleRef.current = false;
  }, [idle, styleUrl]);

  // Desktop split/collapsed changes the canvas's actual CSS box. MapLibre
  // tracks window resizes, not arbitrary sibling geometry, so remeasure it
  // explicitly without recreating the persistent map instance.
  useEffect(() => {
    if (idle) return;
    if (containerRef.current && layoutKey) containerRef.current.dataset.layout = layoutKey;
    mapRef.current?.resize();
  }, [idle, layoutKey]);

  useEffect(() => {
    if (idle) return;
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      (map.getSource("saved") as maplibregl.GeoJSONSource | undefined)?.setData(
        placesToGeoJSON(placePins),
      );
      // Observable projection state for tests and debugging. MapLibre paints
      // asynchronously, but the source has accepted this exact collection.
      if (containerRef.current) containerRef.current.dataset.pins = String(placePins.length);
    };
    if (map.getSource("saved")) apply();
    else map.once("load", apply);
  }, [idle, placePins]);

  useEffect(() => {
    if (idle) return;
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      (map.getSource("pois") as maplibregl.GeoJSONSource | undefined)?.setData(
        poisToGeoJSON(poiPins),
      );
    };
    if (map.getSource("pois")) apply();
    else map.once("load", apply);
  }, [idle, poiPins]);

  useEffect(() => {
    if (idle) return;
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      (map.getSource("marks") as maplibregl.GeoJSONSource | undefined)?.setData(
        marksToGeoJSON(markPins),
      );
      if (containerRef.current) {
        containerRef.current.dataset.marks = String(markPins.length);
      }
    };
    if (map.getSource("marks")) apply();
    else map.once("load", apply);
  }, [idle, markPins]);

  useEffect(() => {
    if (idle) return;
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
  }, [idle, selectionPin]);

  // One camera move per projection change/reveal. If a direct fly request
  // and a route projection were both deferred while hidden, the newer direct
  // selection wins and consumes the fit key: reveal still performs one move.
  const appliedFlyTo = useRef<MapViewProps["flyTo"] | null>(null);
  const _appliedRouteCameraKey = useRef<string | null>(null);
  const appliedFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (idle) return;
    const map = mapRef.current;
    if (!map) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (flyTo && appliedFlyTo.current !== flyTo) {
      appliedFlyTo.current = flyTo;
      if (fitTo) appliedFitKey.current = fitTo.key;
      map.flyTo({
        center: [flyTo.lng, flyTo.lat],
        zoom: flyTo.zoom ?? 17,
        duration: reduceMotion ? 0 : 700,
        // Keep the target clear of the bottom sheet.
        offset: [0, -120],
      });
      return;
    }
    if (!fitTo || appliedFitKey.current === fitTo.key) return;
    appliedFitKey.current = fitTo.key;
    map.fitBounds(
      [
        [fitTo.bounds.west, fitTo.bounds.south],
        [fitTo.bounds.east, fitTo.bounds.north],
      ],
      { padding: 72, maxZoom: 16, duration: reduceMotion ? 0 : 700 },
    );
    if (containerRef.current) containerRef.current.dataset.fitKey = fitTo.key;
  }, [fitTo, flyTo, idle]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} data-testid="map-canvas" className="h-full w-full" />
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="map-attribution"
        className="absolute bottom-0 left-0 z-10 rounded-tr bg-white/90 px-1 py-0.5 text-[10px] text-stone-700 hover:underline"
      >
        {OSM_ATTRIBUTION}
      </a>
      {/* A banner, not a full-bleed takeover: a tile or glyph failure can happen
          over a map that is otherwise drawn and usable, and covering it hides
          information the user already has. */}
      {unavailable ? (
        <div
          role="status"
          className="absolute inset-x-0 top-0 z-10 bg-stone-800/90 px-3 py-2 text-center text-xs text-white"
        >
          <span className="font-semibold">Map unavailable.</span> Part of the map could not load.
          Search and your lists keep working — it returns when the connection does.
        </div>
      ) : null}
    </div>
  );
}
