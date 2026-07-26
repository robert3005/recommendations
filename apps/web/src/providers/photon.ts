/**
 * Photon-class forward geocoding (spec/src/data-sources.md §Geocoder): serves
 * the add-a-place field and the import ladder's Title + Address rung. Every
 * result normalizes to a domain GeocoderCandidate recording its `osmRef` —
 * geocoder results are OSM data (spec/src/data-model.md §Normative rules);
 * nameless or ref-less features are filtered out.
 */
import type { GeocoderCandidate, OsmRef } from "@placemarks/domain";
import { PHOTON_URL } from "../config";

interface PhotonFeature {
  geometry?: { type: string; coordinates?: [number, number] };
  properties?: {
    osm_type?: string;
    osm_id?: number;
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
  };
}

const OSM_TYPE_MAP: Record<string, OsmRef["type"]> = {
  N: "node",
  W: "way",
  R: "relation",
};

function toCandidate(feature: PhotonFeature): GeocoderCandidate | undefined {
  const props = feature.properties;
  const coords = feature.geometry?.coordinates;
  if (!props || !coords) return undefined;
  const type = props.osm_type ? OSM_TYPE_MAP[props.osm_type] : undefined;
  if (!type || props.osm_id === undefined || !props.name) return undefined;
  const address = [
    [props.street, props.housenumber].filter(Boolean).join(" "),
    [props.city, props.postcode].filter(Boolean).join(" "),
  ]
    .filter((part) => part !== "")
    .join(", ");
  return {
    name: props.name,
    lng: coords[0],
    lat: coords[1],
    ...(address ? { address } : {}),
    osmRef: { type, id: String(props.osm_id) },
  };
}

export class PhotonGeocoder {
  constructor(private readonly baseUrl: string = PHOTON_URL) {}

  async search(
    text: string,
    bias?: { lat: number; lng: number },
    opts?: { signal?: AbortSignal; limit?: number },
  ): Promise<GeocoderCandidate[]> {
    const url = new URL(`${this.baseUrl}/api`);
    url.searchParams.set("q", text);
    url.searchParams.set("limit", String(opts?.limit ?? 8));
    if (bias) {
      url.searchParams.set("lat", String(bias.lat));
      url.searchParams.set("lon", String(bias.lng));
    }
    // One retry for a transient upstream failure — adapter policy, so callers
    // do not recreate it (spec/src/data-sources.md: the adapter owns retry).
    let response = await fetch(url, { signal: opts?.signal ?? null });
    if (response.status >= 500) {
      response = await fetch(url, { signal: opts?.signal ?? null });
    }
    if (!response.ok) throw new Error(`photon ${response.status}`);
    const body = (await response.json()) as { features?: PhotonFeature[] };
    return (
      (body.features ?? [])
        .map(toCandidate)
        .filter((result): result is GeocoderCandidate => result !== undefined)
        // The caller's budget binds even when the upstream ignores its limit.
        .slice(0, opts?.limit ?? 8)
    );
  }
}
