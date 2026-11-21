/**
 * The basemap plate (spec/src/design.md §Map styling): a neutral, desaturated,
 * light map built in code from Protomaps vector tiles, so the eight list
 * accents are the loudest thing on the canvas. The plate carries no hue of its
 * own beyond a faint green-grey cast that sits quietly beside the console.
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

/** Plate colours — fixed scene values, not chrome tokens (design.md §Map styling). */
const PLATE = {
  earth: "#F3F4F1",
  background: "#ECEEEA",
  water: "#CBD6D8",
  park: "#E2E9E0",
  wood: "#DCE4DA",
  landuse: "#ECEDE9",
  buildings: "#E3E5E0",
  roadCasing: "#E1E3DE",
  road: "#FFFFFF",
  minorRoad: "#FAFAF8",
  tunnel: "#E6E8E4",
  railway: "#C9CEC9",
  boundaries: "#B9BFB9",
  label: "#6F7A73",
  labelStrong: "#3F4A44",
  labelMuted: "#9AA39C",
  halo: "#F3F4F1",
  waterLabel: "#7E9296",
} as const;

/** The plate flavor: Protomaps' light flavor, recoloured to the plate. */
export function plateFlavor(): Flavor {
  const base = namedFlavor("light");
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
  lang?: string;
}

/** The complete MapLibre style for the plate, sourced from a PMTiles archive. */
export function plateStyle({
  pmtilesUrl,
  glyphsUrl,
  spriteUrl,
  attribution,
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
    layers: layers("protomaps", plateFlavor(), { lang }).filter(
      (layer) => !DROPPED_LAYER_IDS.has(layer.id),
    ) as StyleSpecification["layers"],
  };
}
