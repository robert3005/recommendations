/**
 * Place search on Stadia Maps' geocoder, v2 (spec/src/data-sources.md
 * §Geocoder): OSM plus Foursquare OS Places venues, deduplicated upstream.
 *
 * Three calls, priced very differently, so each is used where it fits:
 *  - `suggest` — `/v2/autocomplete`, one credit per keystroke. Its features
 *    are slim on purpose: a name, a coarse "where" line and a `gid`, and
 *    **no coordinates**.
 *  - `resolve` — `/v2/place_details` for the one suggestion the user picked:
 *    the full record, with its position.
 *  - `search` — `/v2/search`, full records in one call, for the import
 *    ladder's Title + Address rung, which needs positions for every result.
 *    Asked for a name and an address across all layers it answers with the
 *    address record alone, so venues are asked for first and the wider
 *    layers only when no venue matches.
 *
 * A result sourced from OpenStreetMap records its `osmRef`; one from any
 * other source (Foursquare, OpenAddresses, Who's on First) carries none and
 * the model treats it like manual coordinates — no ODbL claim, no OSM deep
 * link (spec/src/data-model.md §Normative rules). Nameless features are
 * filtered.
 */
import type { GeocoderCandidate, OsmRef } from "@placemarks/domain";
import { STADIA_KEY, STADIA_URL } from "../config";

/** One row of the search dropdown: enough to show and to resolve, not to save. */
export interface PlaceSuggestion {
  /** Stadia's `gid` — the handle `resolve` takes. Not stable across data builds. */
  id: string;
  name: string;
  /** The coarse location line, e.g. "London, England". */
  where?: string;
  osmRef?: OsmRef;
}

interface StadiaFeature {
  geometry?: { type?: string; coordinates?: [number, number] } | null;
  properties?: {
    gid?: string;
    name?: string;
    coarse_location?: string;
    formatted_address_line?: string;
    address_components?: { number?: string; street?: string; postal_code?: string };
    context?: { whosonfirst?: { locality?: { name?: string } } };
    sources?: { source?: string; source_id?: string }[];
  };
}

/** OSM element ids read `node/123`, `way/123`, `relation/123`. */
const OSM_ELEMENT = /^(node|way|relation)\/(\d+)$/;
/** An OSM-sourced gid ends in the element id: `openstreetmap:venue:way/123`. */
const OSM_GID = /^openstreetmap:[^:]+:((?:node|way|relation)\/\d+)$/;

function osmRefOf(props: NonNullable<StadiaFeature["properties"]>): OsmRef | undefined {
  const fromSources = props.sources?.find((s) => s.source === "openstreetmap")?.source_id;
  const element = fromSources ?? OSM_GID.exec(props.gid ?? "")?.[1];
  const [, type, id] = OSM_ELEMENT.exec(element ?? "") ?? [];
  return type && id ? { type: type as OsmRef["type"], id } : undefined;
}

function addressOf(props: NonNullable<StadiaFeature["properties"]>): string | undefined {
  const parts = props.address_components;
  const assembled = [
    [parts?.number, parts?.street].filter(Boolean).join(" "),
    [props.context?.whosonfirst?.locality?.name, parts?.postal_code].filter(Boolean).join(" "),
  ]
    .filter((part) => part !== "")
    .join(", ");
  // A street is what makes it an address; a bare locality is the coarse line.
  if (parts?.street && assembled) return assembled;
  // A venue's formatted line leads with its own name; the name is shown apart.
  const line = props.formatted_address_line;
  const rest =
    line && props.name && line.startsWith(`${props.name}, `)
      ? line.slice(props.name.length + 2)
      : line;
  if (rest && rest !== props.name) return rest;
  return props.coarse_location || undefined;
}

function toSuggestion(feature: StadiaFeature): PlaceSuggestion | undefined {
  const props = feature.properties;
  if (!props?.gid || !props.name) return undefined;
  const osmRef = osmRefOf(props);
  return {
    id: props.gid,
    name: props.name,
    ...(props.coarse_location ? { where: props.coarse_location } : {}),
    ...(osmRef ? { osmRef } : {}),
  };
}

function toCandidate(feature: StadiaFeature): GeocoderCandidate | undefined {
  const props = feature.properties;
  const coords = feature.geometry?.coordinates;
  if (!props?.name || !coords) return undefined;
  const address = addressOf(props);
  const osmRef = osmRefOf(props);
  return {
    name: props.name,
    lng: coords[0],
    lat: coords[1],
    ...(address ? { address } : {}),
    ...(osmRef ? { osmRef } : {}),
  };
}

/** Place-shaped layers only — no country or region rows in an add-a-place field. */
const LAYERS = "poi,address,street,locality";
/** Venues alone (Stadia's `poi`, its v1 `venue`). */
const VENUE_LAYER = "poi";

interface CallOptions {
  signal?: AbortSignal;
  limit?: number;
}

export class StadiaGeocoder {
  constructor(
    private readonly baseUrl: string = STADIA_URL,
    private readonly apiKey: string | undefined = STADIA_KEY,
  ) {}

  /** Slim autocomplete rows for the dropdown — no coordinates. */
  async suggest(
    text: string,
    bias?: { lat: number; lng: number },
    opts?: CallOptions,
  ): Promise<PlaceSuggestion[]> {
    const features = await this.get("autocomplete", this.textQuery(text, bias, opts), opts);
    return this.take(features.map(toSuggestion), opts);
  }

  /** The full record behind one suggestion; undefined when it no longer exists. */
  async resolve(id: string, opts?: CallOptions): Promise<GeocoderCandidate | undefined> {
    const features = await this.get("place_details", { ids: id }, opts);
    return features.map(toCandidate).find((candidate) => candidate !== undefined);
  }

  /** Full records in one call, for callers that need every result's position. */
  async search(
    text: string,
    bias?: { lat: number; lng: number },
    opts?: CallOptions,
  ): Promise<GeocoderCandidate[]> {
    const query = this.textQuery(text, bias, opts);
    const venues = await this.get("search", { ...query, layers: VENUE_LAYER }, opts);
    const features = venues.length > 0 ? venues : await this.get("search", query, opts);
    return this.take(features.map(toCandidate), opts);
  }

  private textQuery(
    text: string,
    bias: { lat: number; lng: number } | undefined,
    opts: CallOptions | undefined,
  ): Record<string, string> {
    return {
      text,
      size: String(opts?.limit ?? 8),
      layers: LAYERS,
      ...(bias ? { "focus.point.lat": String(bias.lat), "focus.point.lon": String(bias.lng) } : {}),
    };
  }

  /** The caller's budget binds even when the upstream ignores its size. */
  private take<T>(items: (T | undefined)[], opts: CallOptions | undefined): T[] {
    return items.filter((item): item is T => item !== undefined).slice(0, opts?.limit ?? 8);
  }

  private async get(
    endpoint: "autocomplete" | "place_details" | "search",
    query: Record<string, string>,
    opts: CallOptions | undefined,
  ): Promise<StadiaFeature[]> {
    const url = new URL(`${this.baseUrl}/v2/${endpoint}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    // A deployed site authenticates by its registered domain; a key, where
    // one is configured, travels as a query param — never a header.
    if (this.apiKey) url.searchParams.set("api_key", this.apiKey);
    // One retry for a transient upstream failure — adapter policy, so callers
    // do not recreate it (spec/src/data-sources.md: the adapter owns retry).
    let response = await fetch(url, { signal: opts?.signal ?? null });
    if (response.status >= 500) {
      response = await fetch(url, { signal: opts?.signal ?? null });
    }
    if (!response.ok) throw new Error(`stadia ${response.status}`);
    const body = (await response.json()) as { features?: StadiaFeature[] };
    return body.features ?? [];
  }
}
