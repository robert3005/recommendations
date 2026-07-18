/** OSM element references — see book/src/place-identity.md. OSM ids are serialized as strings. */

export type OsmElementType = "node" | "way" | "relation";

export interface OsmElementRef {
  type: OsmElementType;
  id: string;
}

/** Canonical string form, e.g. "node/1234567890". Used as an index key. */
export function refKey(ref: OsmElementRef): string {
  return `${ref.type}/${ref.id}`;
}

export function parseRefKey(key: string): OsmElementRef | undefined {
  const m = /^(node|way|relation)\/(\d+)$/.exec(key);
  if (!m) return undefined;
  return { type: m[1] as OsmElementType, id: m[2] as string };
}

export function sameRef(a: OsmElementRef, b: OsmElementRef): boolean {
  return a.type === b.type && a.id === b.id;
}

/** Public OSM page for an element (View on OpenStreetMap). */
export function osmElementUrl(ref: OsmElementRef): string {
  return `https://www.openstreetmap.org/${ref.type}/${ref.id}`;
}

/** OSM editor focused on an element (Edit on OpenStreetMap). */
export function osmEditUrl(ref: OsmElementRef): string {
  return `https://www.openstreetmap.org/edit?${ref.type}=${ref.id}`;
}

/** OSM editor at a coordinate (Add it on OpenStreetMap). */
export function osmEditAtUrl(lat: number, lng: number, zoom = 19): string {
  return `https://www.openstreetmap.org/edit#map=${zoom}/${lat.toFixed(5)}/${lng.toFixed(5)}`;
}

/** New OSM note at a coordinate (Report a map issue). */
export function osmNoteUrl(lat: number, lng: number, zoom = 18): string {
  return `https://www.openstreetmap.org/note/new#map=${zoom}/${lat.toFixed(5)}/${lng.toFixed(5)}`;
}
