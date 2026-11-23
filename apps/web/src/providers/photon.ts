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

/** How long to stand off after a rate limit or a dropped request before the one retry. */
export const PHOTON_BACKOFF_MS = 1500;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PhotonGeocoder {
  constructor(
    private readonly baseUrl: string = PHOTON_URL,
    private readonly backoffMs: number = PHOTON_BACKOFF_MS,
  ) {}

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
    // One retry — adapter policy, so callers do not recreate it
    // (spec/src/data-sources.md: the adapter owns retry). A server error
    // retries at once; a rate limit, or a request the network dropped (how a
    // browser sees a rate limit that carries no CORS headers), retries after
    // a short stand-off, which is what lets a long import run to the end.
    const attempt = () => fetch(url, { signal: opts?.signal ?? null });
    let response: Response;
    try {
      response = await attempt();
    } catch (err) {
      if (opts?.signal?.aborted) throw err;
      await wait(this.backoffMs);
      response = await attempt();
    }
    if (response.status === 429) {
      await wait(this.backoffMs);
      response = await attempt();
    } else if (response.status >= 500) {
      response = await attempt();
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
