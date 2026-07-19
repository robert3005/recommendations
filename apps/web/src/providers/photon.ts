/**
 * Photon search adapter (book/src/data-sources.md). Every saveable result must
 * normalize to a typed OSM node/way/relation candidate — nameless or ref-less
 * features are filtered out.
 */
import type { OsmElementType, SearchProvider, SearchResult } from "@placemarks/domain";
import { PHOTON_URL } from "../config";

interface PhotonFeature {
  geometry?: { type: string; coordinates?: [number, number] };
  properties?: {
    osm_type?: string;
    osm_id?: number;
    osm_key?: string;
    osm_value?: string;
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
  };
}

const OSM_TYPE_MAP: Record<string, OsmElementType> = {
  N: "node",
  W: "way",
  R: "relation",
};

function toSearchResult(feature: PhotonFeature): SearchResult | undefined {
  const props = feature.properties;
  const coords = feature.geometry?.coordinates;
  if (!props || !coords) return undefined;
  const type = props.osm_type ? OSM_TYPE_MAP[props.osm_type] : undefined;
  if (!type || props.osm_id === undefined || !props.name) return undefined;
  // Same shape as the domain's assembleAddress: street first, then city+postcode.
  const address = [
    [props.street, props.housenumber].filter(Boolean).join(" "),
    [props.city, props.postcode].filter(Boolean).join(" "),
  ]
    .filter((part) => part !== "")
    .join(", ");
  return {
    ref: { type, id: String(props.osm_id) },
    name: props.name,
    lng: coords[0],
    lat: coords[1],
    ...(props.osm_value ? { category: props.osm_value } : {}),
    ...(address ? { address } : {}),
  };
}

export class PhotonSearchProvider implements SearchProvider {
  constructor(private readonly baseUrl: string = PHOTON_URL) {}

  async search(
    query: string,
    opts?: { signal?: AbortSignal; bias?: { lat: number; lng: number }; limit?: number },
  ): Promise<SearchResult[]> {
    const url = new URL(`${this.baseUrl}/api`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(opts?.limit ?? 8));
    if (opts?.bias) {
      url.searchParams.set("lat", String(opts.bias.lat));
      url.searchParams.set("lon", String(opts.bias.lng));
    }
    const response = await fetch(url, { signal: opts?.signal ?? null });
    if (!response.ok) throw new Error(`photon ${response.status}`);
    const body = (await response.json()) as { features?: PhotonFeature[] };
    return (body.features ?? [])
      .map(toSearchResult)
      .filter((result): result is SearchResult => result !== undefined);
  }
}
