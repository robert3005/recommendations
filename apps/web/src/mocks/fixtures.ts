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
        // No osm_id — must be filtered out: unsaveable results carry no OSM ref.
        name: "Cafe Somewhere",
      },
    },
  ],
};

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
        website: "cafecentral.pt",
        phone: "+351 21 000 0000",
        opening_hours: "Mo-Fr 08:00-18:00; Sa 09:00-14:00",
        "addr:street": "Rua Example",
        "addr:housenumber": "12",
        "addr:city": "Lisboa",
        "addr:postcode": "1100-000",
      },
    },
  ],
};

/** A café with no website tag — the "improve it on OSM" case. */
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

export const overpassNearby = {
  version: 0.6,
  elements: [
    {
      type: "node",
      id: 101,
      lat: 38.7139,
      lon: -9.1394,
      tags: {
        name: "Café Central",
        amenity: "cafe",
        website: "https://cafecentral.pt",
      },
    },
    {
      type: "node",
      id: 300,
      lat: 38.7141,
      lon: -9.1392,
      tags: { name: "Livraria Antiga", shop: "books" },
    },
    {
      type: "way",
      id: 201,
      center: { lat: 38.7107, lon: -9.1421 },
      tags: { name: "Café do Rio", amenity: "cafe" },
    },
  ],
};

export const overpassDiscover = overpassNearby;

/**
 * The node→way replacement scenario (spec/src/place-identity.md recovery):
 * node/599 "Café Migrado" resolves once, then is deleted upstream (410).
 * Its real-world place was redrawn as way/777 with the same identity.
 */
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

/** Recovery candidates near the vanished node: the replacement way + a stranger. */
export const overpassMigradoRecovery = {
  version: 0.6,
  elements: [
    {
      type: "way",
      id: 777,
      center: { lat: 38.72005, lon: -9.16005 },
      tags: {
        name: "Café Migrado",
        amenity: "cafe",
        website: "https://cafemigrado.pt",
      },
    },
    {
      type: "node",
      id: 888,
      lat: 38.7202,
      lon: -9.1603,
      tags: { name: "Farmácia Vizinha", amenity: "pharmacy" },
    },
  ],
};
