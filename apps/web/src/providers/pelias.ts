/**
 * Pelias-class forward geocoding (spec/src/data-sources.md §Geocoder): the
 * Pelias HTTP API as served by Stadia Maps (`/geocoding/v1/autocomplete`),
 * geocode.earth, or a self-hosted Pelias — real POI/venue autocomplete where
 * the Photon demo is not. Only features whose `source` is openstreetmap (with
 * a parseable element id) record an `osmRef`; other sources (openaddresses,
 * whosonfirst, Stadia's foursquare) yield candidates without one, which the
 * model treats like
 * manual coordinates — no ODbL claim, no OSM deep link
 * (spec/src/data-model.md §Normative rules). Nameless features are filtered.
 */
import type { GeocoderCandidate, OsmRef } from "@placemarks/domain";
import { PELIAS_KEY, PELIAS_SOURCES } from "../config";

interface PeliasFeature {
  geometry?: { type: string; coordinates?: [number, number] };
  properties?: {
    name?: string;
    label?: string;
    source?: string;
    source_id?: string;
    housenumber?: string;
    street?: string;
    locality?: string;
    postalcode?: string;
  };
}

/** Pelias OSM source_ids read `node/123`, `way/123`, `relation/123`. */
const OSM_SOURCE_ID = /^(node|way|relation)\/(\d+)$/;

function refOf(props: NonNullable<PeliasFeature["properties"]>): OsmRef | undefined {
  if (props.source !== "openstreetmap" || !props.source_id) return undefined;
  const match = OSM_SOURCE_ID.exec(props.source_id);
  const [, type, id] = match ?? [];
  return type && id ? { type: type as OsmRef["type"], id } : undefined;
}

function addressOf(props: NonNullable<PeliasFeature["properties"]>): string | undefined {
  const assembled = [
    [props.housenumber, props.street].filter(Boolean).join(" "),
    [props.locality, props.postalcode].filter(Boolean).join(" "),
  ]
    .filter((part) => part !== "")
    .join(", ");
  if (assembled) return assembled;
  // Fall back to the display label with the leading name stripped.
  const name = props.name ?? props.label;
  if (!props.label || !name || props.label === name) return undefined;
  return props.label.startsWith(`${name}, `) ? props.label.slice(name.length + 2) : props.label;
}

function toCandidate(feature: PeliasFeature): GeocoderCandidate | undefined {
  const props = feature.properties;
  const coords = feature.geometry?.coordinates;
  if (!props || !coords) return undefined;
  const name = props.name ?? props.label;
  if (!name) return undefined;
  const address = addressOf(props);
  const osmRef = refOf(props);
  return {
    name,
    lng: coords[0],
    lat: coords[1],
    ...(address ? { address } : {}),
    ...(osmRef ? { osmRef } : {}),
  };
}

export class PeliasGeocoder {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined = PELIAS_KEY,
    /** Comma-separated upstream sources to search; absent, the upstream's default set. */
    private readonly sources: string | undefined = PELIAS_SOURCES,
  ) {}

  async search(
    text: string,
    bias?: { lat: number; lng: number },
    opts?: { signal?: AbortSignal; limit?: number },
  ): Promise<GeocoderCandidate[]> {
    const url = new URL(`${this.baseUrl}/v1/autocomplete`);
    url.searchParams.set("text", text);
    url.searchParams.set("size", String(opts?.limit ?? 8));
    // Place-shaped layers only — no country/region rows in a search field.
    url.searchParams.set("layers", "venue,address,street,locality");
    if (bias) {
      url.searchParams.set("focus.point.lat", String(bias.lat));
      url.searchParams.set("focus.point.lon", String(bias.lng));
    }
    if (this.sources) url.searchParams.set("sources", this.sources);
    // The key travels as a query param — never a header.
    if (this.apiKey) url.searchParams.set("api_key", this.apiKey);
    // One retry for a transient upstream failure — adapter policy, so callers
    // do not recreate it (spec/src/data-sources.md: the adapter owns retry).
    let response = await fetch(url, { signal: opts?.signal ?? null });
    if (response.status >= 500) {
      response = await fetch(url, { signal: opts?.signal ?? null });
    }
    if (!response.ok) throw new Error(`pelias ${response.status}`);
    const body = (await response.json()) as { features?: PeliasFeature[] };
    return (
      (body.features ?? [])
        .map(toCandidate)
        .filter((result): result is GeocoderCandidate => result !== undefined)
        // The caller's budget binds even when the upstream ignores its limit.
        .slice(0, opts?.limit ?? 8)
    );
  }
}
