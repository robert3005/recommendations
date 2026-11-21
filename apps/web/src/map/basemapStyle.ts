/**
 * The basemap plate (spec/src/design.md §Map styling): a neutral, desaturated
 * map built in code from Protomaps vector tiles, so the eight list accents are
 * the loudest thing on the canvas. It follows the chrome's two themes: warm
 * light greys beside Paper (#FCFCF9), and a dark plate around Night (#171716)
 * with hairline-level roads and labels at reduced strength.
 *
 * Built with @protomaps/basemaps: the layer schema is theirs, the colours are
 * ours. POI icons and road shields are dropped — the only points of interest
 * on this map are the user's own places.
 */
import { type Flavor, layers, namedFlavor } from "@protomaps/basemaps";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";

// The plate is a single PMTiles archive read by HTTP range request
// (spec/src/data-sources.md §Map tiles); MapLibre learns the scheme once.
let pmtilesRegistered = false;
function ensurePmtilesProtocol() {
  if (pmtilesRegistered) return;
  pmtilesRegistered = true;
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
}

/** The chrome theme the plate sits beside. */
export type PlateScheme = "paper" | "night";

interface PlatePalette {
  earth: string;
  background: string;
  water: string;
  park: string;
  wood: string;
  landuse: string;
  buildings: string;
  roadCasing: string;
  road: string;
  minorRoad: string;
  tunnel: string;
  railway: string;
  boundaries: string;
  label: string;
  labelStrong: string;
  labelMuted: string;
  halo: string;
  waterLabel: string;
}

/** Plate colours — fixed scene values, not chrome tokens (design.md §Map styling). */
const PALETTES: Record<PlateScheme, PlatePalette> = {
  // Warm neutral greys that read as one surface with the Paper chrome.
  paper: {
    earth: "#F6F5F1",
    background: "#F0EFEA",
    water: "#DCDDD9",
    park: "#ECEBE4",
    wood: "#E6E5DD",
    landuse: "#F1F0EB",
    buildings: "#E8E7E1",
    roadCasing: "#E2E1DB",
    road: "#FFFFFF",
    minorRoad: "#FCFCF9",
    tunnel: "#EBEAE5",
    railway: "#CFCEC8",
    boundaries: "#BDBCB5",
    label: "#75746E",
    labelStrong: "#3A3935",
    labelMuted: "#A3A29B",
    halo: "#F6F5F1",
    waterLabel: "#8A8B87",
  },
  // Night: land at the chrome's ground, roads at hairline strength, labels
  // toward the ink but held back so the pins stay the loudest thing.
  night: {
    earth: "#1C1C1B",
    background: "#171716",
    water: "#121211",
    park: "#1F201E",
    wood: "#21221F",
    landuse: "#1E1E1C",
    buildings: "#252523",
    roadCasing: "#1C1C1B",
    road: "#343431",
    minorRoad: "#2A2A28",
    tunnel: "#262624",
    railway: "#3A3A37",
    boundaries: "#4A4A46",
    label: "#A3A39D",
    labelStrong: "#CFCFC9",
    labelMuted: "#74746F",
    halo: "#171716",
    waterLabel: "#6C6C67",
  },
};

/**
 * Colours painted INTO the map scene for the user's pins and clusters: they
 * contrast against the plate, not the chrome (design.md §Map styling).
 */
export const PLATE_SCENE: Record<PlateScheme, { outline: string; ink: string }> = {
  paper: { outline: "#FCFCF9", ink: "#171716" },
  night: { outline: "#171716", ink: "#F3F3EF" },
};

/** The plate flavor: Protomaps' light/dark flavor, recoloured to the plate. */
export function plateFlavor(scheme: PlateScheme = "paper"): Flavor {
  const base = namedFlavor(scheme === "night" ? "dark" : "light");
  const PLATE = PALETTES[scheme];
  return {
    ...base,
    background: PLATE.background,
    earth: PLATE.earth,
    park_a: PLATE.park,
    park_b: PLATE.park,
    wood_a: PLATE.wood,
    wood_b: PLATE.wood,
    scrub_a: PLATE.park,
    scrub_b: PLATE.park,
    glacier: PLATE.earth,
    sand: PLATE.landuse,
    beach: PLATE.landuse,
    hospital: PLATE.landuse,
    industrial: PLATE.landuse,
    school: PLATE.landuse,
    pedestrian: PLATE.landuse,
    aerodrome: PLATE.landuse,
    runway: PLATE.road,
    zoo: PLATE.park,
    military: PLATE.landuse,
    water: PLATE.water,
    pier: PLATE.landuse,
    buildings: PLATE.buildings,

    tunnel_other_casing: PLATE.roadCasing,
    tunnel_minor_casing: PLATE.roadCasing,
    tunnel_link_casing: PLATE.roadCasing,
    tunnel_major_casing: PLATE.roadCasing,
    tunnel_highway_casing: PLATE.roadCasing,
    tunnel_other: PLATE.tunnel,
    tunnel_minor: PLATE.tunnel,
    tunnel_link: PLATE.tunnel,
    tunnel_major: PLATE.tunnel,
    tunnel_highway: PLATE.tunnel,

    minor_service_casing: PLATE.roadCasing,
    minor_casing: PLATE.roadCasing,
    link_casing: PLATE.roadCasing,
    major_casing_late: PLATE.roadCasing,
    highway_casing_late: PLATE.roadCasing,
    major_casing_early: PLATE.roadCasing,
    highway_casing_early: PLATE.roadCasing,
    other: PLATE.minorRoad,
    minor_service: PLATE.minorRoad,
    minor_a: PLATE.minorRoad,
    minor_b: PLATE.road,
    link: PLATE.road,
    major: PLATE.road,
    highway: PLATE.road,
    railway: PLATE.railway,
    boundaries: PLATE.boundaries,

    bridges_other_casing: PLATE.roadCasing,
    bridges_minor_casing: PLATE.roadCasing,
    bridges_link_casing: PLATE.roadCasing,
    bridges_major_casing: PLATE.roadCasing,
    bridges_highway_casing: PLATE.roadCasing,
    bridges_other: PLATE.minorRoad,
    bridges_minor: PLATE.road,
    bridges_link: PLATE.road,
    bridges_major: PLATE.road,
    bridges_highway: PLATE.road,

    roads_label_minor: PLATE.labelMuted,
    roads_label_minor_halo: PLATE.halo,
    roads_label_major: PLATE.label,
    roads_label_major_halo: PLATE.halo,
    ocean_label: PLATE.waterLabel,
    subplace_label: PLATE.label,
    subplace_label_halo: PLATE.halo,
    city_label: PLATE.labelStrong,
    city_label_halo: PLATE.halo,
    state_label: PLATE.labelMuted,
    state_label_halo: PLATE.halo,
    country_label: PLATE.label,
    address_label: PLATE.labelMuted,
    address_label_halo: PLATE.halo,

    landcover: {
      barren: PLATE.earth,
      farmland: PLATE.earth,
      forest: PLATE.wood,
      glacier: PLATE.earth,
      grassland: PLATE.park,
      scrub: PLATE.park,
      urban_area: PLATE.landuse,
    },
  };
}

/** A font the plate's glyph server serves, for the app's own map labels. */
export const PLATE_OVERLAY_FONT = "Noto Sans Medium";

/** Layers that would compete with the user's pins. */
const DROPPED_LAYER_IDS = new Set(["pois", "roads_shields"]);

export interface PlateStyleOptions {
  /** Absolute URL of the Protomaps-schema .pmtiles archive. */
  pmtilesUrl: string;
  /** MapLibre glyphs template (`{fontstack}` / `{range}`). */
  glyphsUrl: string;
  /** MapLibre sprite base URL (one-way arrows, town dots). */
  spriteUrl: string;
  attribution: string;
  scheme?: PlateScheme;
  lang?: string;
}

/**
 * The plate's layers for one scheme. Both schemes share layer ids and layouts,
 * so switching theme only repaints these — the map keeps its sources, our own
 * layers, and the camera.
 */
export function plateLayers(scheme: PlateScheme, lang = "en"): StyleSpecification["layers"] {
  return layers("protomaps", plateFlavor(scheme), { lang })
    .filter((layer) => !DROPPED_LAYER_IDS.has(layer.id))
    .map((layer) =>
      // The sprite is the light one; one-way arrows recede on the dark plate.
      scheme === "night" && layer.id === "roads_oneway"
        ? { ...layer, paint: { ...layer.paint, "icon-opacity": 0.3 } }
        : layer,
    ) as StyleSpecification["layers"];
}

/** The complete MapLibre style for the plate, sourced from a PMTiles archive. */
export function plateStyle({
  pmtilesUrl,
  glyphsUrl,
  spriteUrl,
  attribution,
  scheme = "paper",
  lang = "en",
}: PlateStyleOptions): StyleSpecification {
  ensurePmtilesProtocol();
  return {
    version: 8,
    glyphs: glyphsUrl,
    sprite: spriteUrl,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${pmtilesUrl}`,
        attribution,
      },
    },
    layers: plateLayers(scheme, lang),
  };
}
