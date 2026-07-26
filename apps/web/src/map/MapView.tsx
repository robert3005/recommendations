/**
 * Thin MapLibre adapter (spec/src/tech-stack.md: no wrapper library — we own
 * this boundary). Renders the basemap with required OSM attribution, library
 * pins wearing their list's marker shape (clustered), labelled import-review
 * marks, the selection ring, and reports gestures upward. No domain logic
 * lives here.
 */
import type { BBox, ListMarker, MarkerShape } from "@placemarks/domain";
import { MARKER_SHAPE_PATHS } from "@placemarks/domain";
import type { FeatureCollection } from "geojson";
import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { OSM_ATTRIBUTION, VIEWPORT_DEBOUNCE_MS } from "../config";

export interface PlacePinFeature {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  /** The marker the pin wears — a solid accent-coloured shape (spec/src/design.md). */
  marker: ListMarker;
  /** On several visible lists: the next list's marker peeks out behind. */
  stackedMarker?: ListMarker;
  /** Number of visible lists containing the place; 3+ adds a numeral badge. */
  listCount: number;
  /** Outside the current projection's focus: rendered dimmed. */
  dimmed: boolean;
}

/** A labelled transient mark — import-review candidates (A, B, C…). */
export interface MarkPinFeature {
  key: string;
  name: string;
  label: string;
  lat: number;
  lng: number;
}

export interface MapViewProps {
  styleUrl: string;
  /**
   * The mobile sheet fully covers the canvas: retain the scene, apply nothing.
   * Projections apply lazily on reveal — every projection effect is gated on
   * this flag and re-runs against current values when it clears.
   */
  covered?: boolean;
  /** Changes when shell geometry changes so MapLibre remeasures its canvas. */
  layoutKey?: string;
  /** Starting camera — the caller decides (persisted viewport / timezone approximation). */
  initialCenter: { lat: number; lng: number };
  initialZoom: number;
  placePins: PlacePinFeature[];
  markPins?: MarkPinFeature[];
  /** The currently selected place — marked immediately with a ring. */
  selectionPin?: { lat: number; lng: number } | null;
  flyTo?: { lat: number; lng: number; zoom?: number } | null;
  /**
   * One camera move to frame a projection (route change / reveal). `key`
   * de-duplicates: the move applies once per distinct key.
   */
  fitTo?: { bounds: BBox; key: string } | null;
  onSelectPlace?: (placeId: string) => void;
  onSelectMark?: (mark: MarkPinFeature) => void;
  /** A plain map click that hit no pin — import review places items with it. */
  onMapClick?: (pos: { lat: number; lng: number }) => void;
  onViewportChange?: (view: {
    bbox: BBox;
    zoom: number;
    center: { lat: number; lng: number };
  }) => void;
}

/**
 * Our own GeoJSON sources. Exported because two places must agree about them:
 * the layer setup that creates them, and the basemap-recovery guard that must
 * NOT treat their data events as evidence the basemap came back.
 */
export const OUR_SOURCE_IDS = ["saved", "marks", "selection"] as const;

const PIN_LAYER_IDS = ["saved-pins", "saved-clusters", "mark-pins"] as const;

/**
 * The basemap stays the LIGHT plate while the app chrome is the deep-green
 * console (spec/src/design.md §Map styling). Everything painted INTO the map
 * scene — pin outlines, cluster discs, mark labels, the selection ring —
 * contrasts against that light plate, so these are fixed plate values, not
 * the (dark) chrome tokens.
 */
const PLATE = "#FAF7F2";
const PLATE_INK = "#221D16";

/** Sprite id for a marker variant — parsed back by the sprite painter. */
function markerImageId(pin: PlacePinFeature): string {
  const stacked = pin.stackedMarker
    ? `${pin.stackedMarker.shape}|${pin.stackedMarker.color}`
    : "-|-";
  return `pm|${pin.marker.shape}|${pin.marker.color}|${stacked}|${String(pin.listCount)}`;
}

/**
 * Paint a marker sprite: one solid accent-coloured shape from
 * MARKER_SHAPE_PATHS (shared with list rows, so the two renderings can never
 * diverge), the stacked second-list shape peeking out behind, and a numeral
 * badge for 3+ lists — the deterministic multi-list variant.
 */
function paintMarkerImage(id: string): ImageData | undefined {
  const [, shape = "circle", color = PLATE_INK, shape2 = "-", color2 = "-", countRaw = "1"] =
    id.split("|");
  const count = Number.parseInt(countRaw, 10) || 1;
  if (typeof document === "undefined" || typeof Path2D === "undefined") return undefined;
  const size = 64; // 2× for retina; icon-size 0.5 in the layer
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;

  // Path data is authored on a 30×30 viewBox.
  const drawShape = (shapeName: string, fill: string, scale: number, dx: number, dy: number) => {
    const d = MARKER_SHAPE_PATHS[shapeName as MarkerShape] ?? (MARKER_SHAPE_PATHS.circle as string);
    const path = new Path2D(d);
    const px = (size * scale) / 30;
    ctx.save();
    ctx.translate(size / 2 - 15 * px + dx, size / 2 - 15 * px + dy);
    ctx.scale(px, px);
    ctx.fillStyle = fill;
    ctx.fill(path);
    ctx.lineWidth = 2.5 / px;
    ctx.strokeStyle = PLATE;
    ctx.stroke(path);
    ctx.restore();
  };

  if (shape2 !== "-" && color2 !== "-") drawShape(shape2, color2, 0.66, 9, -9);
  drawShape(shape, color, 0.78, 0, shape2 === "-" ? 0 : 3);
  if (count > 2) {
    ctx.beginPath();
    ctx.arc(size * 0.82, size * 0.82, size * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = PLATE_INK;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = PLATE;
    ctx.stroke();
    ctx.fillStyle = PLATE;
    ctx.font = `bold ${(size * 0.22).toString()}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(count), size * 0.82, size * 0.83);
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

function marksToGeoJSON(pins: MarkPinFeature[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
      properties: { key: pin.key, name: pin.name, label: pin.label },
    })),
  };
}

export function MapView({
  styleUrl,
  covered = false,
  layoutKey,
  initialCenter,
  initialZoom,
  placePins,
  markPins = [],
  selectionPin,
  flyTo,
  fitTo,
  onSelectPlace,
  onSelectMark,
  onMapClick,
  onViewportChange,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const wasCoveredRef = useRef(covered);
  const callbacksRef = useRef({ onSelectPlace, onSelectMark, onMapClick, onViewportChange });
  callbacksRef.current = { onSelectPlace, onSelectMark, onMapClick, onViewportChange };
  const placePinsRef = useRef(placePins);
  placePinsRef.current = placePins;
  const markPinsRef = useRef(markPins);
  markPinsRef.current = markPins;
  const selectionPinRef = useRef(selectionPin);
  selectionPinRef.current = selectionPin;
  // A basemap that never establishes itself is a designed state, not a blank
  // canvas (spec/src/map-view.md §Accessibility and failure).
  const [unavailable, setUnavailable] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the initial camera/style apply once at singleton creation; later changes reconcile in effects below without recreating the map.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      center: [initialCenter.lng, initialCenter.lat],
      zoom: initialZoom,
      attributionControl: false,
    });
    mapRef.current = map;

    // OSM attribution is a licensing requirement on every map surface.
    map.addControl(new maplibregl.AttributionControl({ compact: false }));
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    // Geolocation is user-triggered; denial/timeout must never block the map.
    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 8000 },
      trackUserLocation: false,
      showUserLocation: true,
    });
    map.addControl(geolocate, "top-right");
    geolocate.on("error", () => {
      // Designed state, not a blank screen: the map stays fully usable without location.
    });

    // Marker sprites are painted on demand — every (shape, colour, stack,
    // count) variant materializes the first time a pin wears it.
    map.on("styleimagemissing", (event: { id: string }) => {
      if (!event.id.startsWith("pm|") || map.hasImage(event.id)) return;
      const image = paintMarkerImage(event.id);
      if (image) map.addImage(event.id, image, { pixelRatio: 2 });
    });

    // Observable view state for tests and debugging (canvas pixels are not
    // inspectable without preserveDrawingBuffer, which costs performance).
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
    // going idle (spec/src/map-view.md §Accessibility and failure).
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
      setUnavailable(false);
      // Library pins wear their list's marker shape; clustered at low zoom so
      // large lists stay responsive (spec/src/map-view.md §The grammar).
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
          "circle-color": PLATE_INK,
          "circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 50, 24],
          "circle-stroke-width": 2,
          "circle-stroke-color": PLATE,
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
        paint: { "text-color": PLATE },
      });
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

      // Labelled transient marks (import-review candidates: A, B, C…).
      map.addSource("marks", { type: "geojson", data: marksToGeoJSON(markPinsRef.current) });
      map.addLayer({
        id: "mark-pins",
        type: "circle",
        source: "marks",
        paint: {
          "circle-color": "#E43D1F",
          "circle-radius": 10,
          "circle-stroke-width": 2,
          "circle-stroke-color": PLATE,
        },
      });
      map.addLayer({
        id: "mark-labels",
        type: "symbol",
        source: "marks",
        layout: { "text-field": ["get", "label"], "text-size": 11 },
        paint: { "text-color": PLATE },
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
          "circle-radius": 13,
          "circle-color": "#000000",
          "circle-opacity": 0,
          "circle-stroke-width": 3,
          "circle-stroke-color": PLATE_INK,
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
      map.on("click", "mark-pins", (e) => {
        const keyProp = e.features?.[0]?.properties?.key as string | undefined;
        const mark = markPinsRef.current.find((m) => m.key === keyProp);
        if (mark) callbacksRef.current.onSelectMark?.(mark);
      });
      for (const layer of PIN_LAYER_IDS) {
        map.on("mouseenter", layer, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }
    });

    // A plain click that hit no pin — import review's manual placement
    // (spec/src/map-view.md §Import review). Pin layers see the click first;
    // query them so a candidate tap is never also a placement.
    map.on("click", (e) => {
      if (!callbacksRef.current.onMapClick) return;
      if (typeof map.queryRenderedFeatures === "function" && map.getLayer?.("saved-pins")) {
        const hits = map.queryRenderedFeatures(e.point, { layers: [...PIN_LAYER_IDS] });
        if (hits.length > 0) return;
      }
      callbacksRef.current.onMapClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    // Debounced viewport reporting — the persisted camera, not discovery.
    let moveTimer: ReturnType<typeof setTimeout> | undefined;
    map.on("moveend", () => {
      if (coveredRef.current) return;
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (coveredRef.current) return;
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
      if (moveTimer) clearTimeout(moveTimer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // The reveal guard: while covered nothing applies; on reveal, remeasure and
  // let the gated projection effects below re-run against current values.
  useEffect(() => {
    if (containerRef.current) containerRef.current.dataset.covered = covered ? "1" : "0";
    if (covered) {
      wasCoveredRef.current = true;
      return;
    }
    if (!wasCoveredRef.current) return;
    wasCoveredRef.current = false;
    mapRef.current?.resize();
    mapRef.current?.triggerRepaint();
  }, [covered]);

  // A style URL change reconciles in place — the singleton never remounts.
  const appliedStyleUrlRef = useRef(styleUrl);
  useEffect(() => {
    if (appliedStyleUrlRef.current === styleUrl) return;
    appliedStyleUrlRef.current = styleUrl;
    mapRef.current?.setStyle(styleUrl);
  }, [styleUrl]);

  // Desktop split/collapsed changes the canvas's actual CSS box. MapLibre
  // tracks window resizes, not arbitrary sibling geometry, so remeasure it
  // explicitly without recreating the persistent map instance.
  useEffect(() => {
    if (covered) return;
    if (containerRef.current && layoutKey) containerRef.current.dataset.layout = layoutKey;
    mapRef.current?.resize();
  }, [covered, layoutKey]);

  useEffect(() => {
    if (covered) return;
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
  }, [covered, placePins]);

  useEffect(() => {
    if (covered) return;
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      (map.getSource("marks") as maplibregl.GeoJSONSource | undefined)?.setData(
        marksToGeoJSON(markPins),
      );
      if (containerRef.current) containerRef.current.dataset.marks = String(markPins.length);
    };
    if (map.getSource("marks")) apply();
    else map.once("load", apply);
  }, [covered, markPins]);

  useEffect(() => {
    if (covered) return;
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
  }, [covered, selectionPin]);

  // One camera move per projection change/reveal. If a direct fly request and
  // a route projection were both deferred while covered, the newer direct
  // selection wins and consumes the fit key: reveal still performs one move.
  const appliedFlyTo = useRef<MapViewProps["flyTo"] | null>(null);
  const appliedFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (covered) return;
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
  }, [fitTo, flyTo, covered]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} data-testid="map-canvas" className="h-full w-full" />
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="map-attribution"
        className="absolute bottom-0 left-0 z-10 rounded-tr-crisp bg-paper/90 px-1 py-0.5 text-[10px] text-ink hover:underline"
      >
        {OSM_ATTRIBUTION}
      </a>
      {/* A top banner, not a full-bleed takeover: a tile or glyph failure can
          happen over a map that is otherwise drawn and usable, and covering it
          hides information the user already has. Deep console chrome over the
          light plate, like every control floating on the map. */}
      {unavailable ? (
        <div
          role="status"
          className="absolute inset-x-0 top-0 z-10 border-b border-hairline bg-paper/95 px-3 py-2 text-center text-xs text-ink"
        >
          <span className="font-semibold">Map unavailable.</span> Part of the map could not load.
          Search and your lists keep working — it returns when the connection does.
        </div>
      ) : null}
    </div>
  );
}
