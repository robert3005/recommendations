/** Shared fixtures for MSW handlers, vitest, and Storybook. */

export const photonCafeResponse = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-9.1394, 38.7139] },
      properties: {
        osm_type: "N",
        osm_id: 101,
        osm_key: "amenity",
        osm_value: "cafe",
        name: "Café Central",
        street: "Rua Example",
        housenumber: "12",
        city: "Lisboa",
        postcode: "1100-000",
        countrycode: "PT",
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-9.1421, 38.7107] },
      properties: {
        osm_type: "W",
        osm_id: 201,
        osm_key: "amenity",
        osm_value: "cafe",
        name: "Café do Rio",
        city: "Lisboa",
        countrycode: "PT",
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [2.35, 48.85] },
      properties: {
        // No osm_id — geocoder results are OSM data; a result without a ref
        // cannot record an osmRef and is filtered out.
        name: "Cafe Somewhere",
      },
    },
  ],
};

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

/** A second searchable café, distinct from the "caf" query's results. */
export const photonMigradoResponse = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-9.16, 38.72] },
      properties: {
        osm_type: "N",
        osm_id: 599,
        osm_key: "amenity",
        osm_value: "cafe",
        name: "Café Migrado",
        city: "Lisboa",
        countrycode: "PT",
      },
    },
  ],
};

/** Base URL for the Pelias-class mock when no VITE_PELIAS_URL is configured. */
export const PELIAS_TEST_URL = "https://pelias.test";

/**
 * Pelias /v1/autocomplete response: the parse table for the Pelias-class
 * adapter. Only openstreetmap-sourced features with a parseable element id
 * record an osmRef; openaddresses/whosonfirst rows are kept without one;
 * nameless features are filtered.
 */
export const peliasCafeResponse = {
  geocoding: { version: "0.2" },
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-9.1394, 38.7139] },
      properties: {
        gid: "openstreetmap:venue:node/301",
        layer: "venue",
        source: "openstreetmap",
        source_id: "node/301",
        name: "Café Pelias",
        housenumber: "12",
        street: "Rua Example",
        locality: "Lisboa",
        postalcode: "1100-000",
        label: "Café Pelias, Lisboa, Portugal",
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-9.1421, 38.7107] },
      properties: {
        gid: "openstreetmap:venue:way/401",
        layer: "venue",
        source: "openstreetmap",
        source_id: "way/401",
        name: "Café da Doca",
        label: "Café da Doca, Lisboa, Portugal",
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-9.15, 38.71] },
      properties: {
        // OpenAddresses row — an open source that is not OSM: no osmRef.
        gid: "openaddresses:address:pt/lisboa:0a1b2c",
        layer: "address",
        source: "openaddresses",
        source_id: "pt/lisboa:0a1b2c",
        name: "14 Rua Aberta",
        housenumber: "14",
        street: "Rua Aberta",
        locality: "Lisboa",
        postalcode: "1100-001",
        label: "14 Rua Aberta, Lisboa, Portugal",
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-9.14, 38.72] },
      properties: {
        // Who's on First locality — numeric source_id, so no osmRef either.
        gid: "whosonfirst:locality:101751269",
        layer: "locality",
        source: "whosonfirst",
        source_id: "101751269",
        name: "Lisboa",
        label: "Lisboa, Portugal",
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [2.35, 48.85] },
      properties: {
        // Neither name nor label — filtered out.
        layer: "venue",
        source: "openstreetmap",
        source_id: "node/999",
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
