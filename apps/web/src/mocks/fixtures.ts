/** Shared fixtures for MSW handlers, vitest, and Storybook. */

/**
 * The mock geocoder's world, as full Stadia v2 features (the shape
 * `/v2/place_details` and `/v2/search` answer with). `/v2/autocomplete`
 * serves the same places slimmed — no geometry, no sources.
 */
function stadiaPlace(
  gid: string,
  name: string,
  coordinates: [number, number],
  extra: {
    coarse_location: string;
    address_components?: { number?: string; street?: string; postal_code?: string };
    formatted_address_line?: string;
    sources: { source: string; source_id: string }[];
  },
) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: {
      gid,
      layer: "poi",
      name,
      precision: "point",
      context: { whosonfirst: { locality: { name: "Lisboa" } } },
      ...extra,
    },
  };
}

/** What a "caf" query finds: two OSM cafés whose elements the OSM API mock serves. */
export const stadiaCafePlaces = [
  stadiaPlace("openstreetmap:venue:node/101", "Café Central", [-9.1394, 38.7139], {
    coarse_location: "Lisboa, Portugal",
    address_components: { number: "12", street: "Rua Example", postal_code: "1100-000" },
    formatted_address_line: "Rua Example 12, 1100-000 Lisboa",
    sources: [{ source: "openstreetmap", source_id: "node/101" }],
  }),
  stadiaPlace("openstreetmap:venue:way/201", "Café do Rio", [-9.1421, 38.7107], {
    coarse_location: "Lisboa, Portugal",
    sources: [{ source: "openstreetmap", source_id: "way/201" }],
  }),
];

/** A second searchable café, distinct from the "caf" query's results. */
export const stadiaMigradoPlaces = [
  stadiaPlace("openstreetmap:venue:node/599", "Café Migrado", [-9.16, 38.72], {
    coarse_location: "Lisboa, Portugal",
    sources: [{ source: "openstreetmap", source_id: "node/599" }],
  }),
];

/** A venue only Foursquare knows — no OSM element, so no osmRef. */
export const stadiaFoursquarePlace = stadiaPlace(
  "foursquare:venue:652285383d92070f5588d28b",
  "Colonna & Small’s",
  [-0.110035, 51.521636],
  {
    coarse_location: "London, England",
    sources: [{ source: "foursquare", source_id: "652285383d92070f5588d28b" }],
  },
);

export type StadiaPlaceFixture = ReturnType<typeof stadiaPlace>;

/** The slim `/v2/autocomplete` rendering of a place: no geometry, no sources. */
export function stadiaSuggestion(place: StadiaPlaceFixture) {
  const { gid, layer, name, precision, coarse_location } = place.properties;
  return {
    type: "Feature",
    geometry: null,
    properties: { gid, layer, name, precision, coarse_location },
  };
}

export const stadiaCollection = (features: unknown[]) => ({
  type: "FeatureCollection",
  geocoding: { attribution: "https://stadiamaps.com/attribution/" },
  features,
});

/** The richly tagged element: every POI fact the lookup captures, plus a wikipedia tag. */
export const osmNode101 = {
  version: "0.6",
  elements: [
    {
      type: "node",
      id: 101,
      lat: 38.7139,
      lon: -9.1394,
      version: 5,
      tags: {
        name: "Café Central",
        amenity: "cafe",
        website: "https://cafecentral.pt",
        phone: "+351 21 000 0000",
        opening_hours: "Mo-Fr 08:00-18:00; Sa 09:00-14:00",
        cuisine: "portuguese",
        wheelchair: "limited",
        description: "Historic café on Rua Example, pouring bica since 1923.",
        wikipedia: "pt:Café Central (Lisboa)",
        wikimedia_commons: "File:Café Central (Lisboa).jpg",
        "addr:street": "Rua Example",
        "addr:housenumber": "12",
        "addr:city": "Lisboa",
        "addr:postcode": "1100-000",
      },
    },
  ],
};

/**
 * Wikipedia REST summary for osmNode101's `wikipedia` tag ("pt:Café Central
 * (Lisboa)") — the shape of /api/rest_v1/page/summary/<title>.
 */
export const wikipediaSummaryCafeCentral = {
  type: "standard",
  title: "Café Central (Lisboa)",
  extract:
    "O Café Central é um café histórico de Lisboa, fundado em 1923, conhecido pela sua fachada em azulejo e pela tertúlia literária.",
  thumbnail: {
    source:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Cafe_Central_Lisboa.jpg/320px-Cafe_Central_Lisboa.jpg",
    width: 320,
    height: 240,
  },
  content_urls: {
    desktop: { page: "https://pt.wikipedia.org/wiki/Caf%C3%A9_Central_(Lisboa)" },
    mobile: { page: "https://pt.m.wikipedia.org/wiki/Caf%C3%A9_Central_(Lisboa)" },
  },
};

/** A café with barely any tags — the sparse-lookup case. */
export const osmNode102 = {
  version: "0.6",
  elements: [
    {
      type: "node",
      id: 102,
      lat: 38.71,
      lon: -9.14,
      version: 2,
      tags: { name: "Quiosque Sem Site", amenity: "cafe" },
    },
  ],
};

/** way/201 full response: way + its nodes, for representative-point computation. */
export const osmWay201Full = {
  version: "0.6",
  elements: [
    { type: "node", id: 9001, lat: 38.7105, lon: -9.1423 },
    { type: "node", id: 9002, lat: 38.7109, lon: -9.1419 },
    { type: "node", id: 9003, lat: 38.7107, lon: -9.1421 },
    {
      type: "way",
      id: 201,
      version: 7,
      nodes: [9001, 9002, 9003],
      tags: {
        name: "Café do Rio",
        amenity: "cafe",
        "contact:website": "https://cafedorio.pt",
      },
    },
  ],
};

export const osmNode599 = {
  version: "0.6",
  elements: [
    {
      type: "node",
      id: 599,
      lat: 38.72,
      lon: -9.16,
      version: 4,
      tags: {
        name: "Café Migrado",
        amenity: "cafe",
        website: "https://cafemigrado.pt",
      },
    },
  ],
};

/** A share-sheet short link and the place URL its redirect points at. */
export const SHORT_LINK_FIXTURE = {
  short: "https://maps.app.goo.gl/ahHp1Y6MdgxDMFfb9",
  expanded:
    "https://www.google.com/maps/place/Colonna+&+Small's/@51.5216362,-0.1125268,17z/data=!3m1!4b1!4m6!3m5!1s0x48761b6656cb87d5:0x2e6defda184b96ec!8m2!3d51.5216329!4d-0.1099519!16s%2Fg%2F11l20l2p36",
} as const;
