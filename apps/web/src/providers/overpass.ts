/**
 * Overpass adapter for area queries: nearby candidates (long-press picker, identity
 * recovery) and bounded viewport discovery. Budgets per book/src/data-sources.md.
 * The public instance is development-only; production points OVERPASS_URL elsewhere.
 */
import {
  type BBox,
  bboxAreaKm2,
  type DiscoverResult,
  type OsmElementType,
  type ResolvedPoi,
  resolvedPoiFromTags,
} from "@placemarks/domain";
import { DISCOVER_LIMIT, OVERPASS_URL } from "../config";

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const MAX_DISCOVER_AREA_KM2 = 4;
const POI_FILTER = `["name"]["amenity"!~"^$"],["name"]["shop"],["name"]["tourism"],["name"]["leisure"]`;

function toPoi(element: OverpassElement, resolvedAt: string): ResolvedPoi | undefined {
  if (!element.tags || !["node", "way", "relation"].includes(element.type)) return undefined;
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (lat === undefined || lng === undefined) return undefined;
  return resolvedPoiFromTags({
    ref: { type: element.type as OsmElementType, id: String(element.id) },
    tags: element.tags,
    lat,
    lng,
    resolvedAt,
  });
}

export class OverpassProvider {
  constructor(
    private readonly baseUrl: string = OVERPASS_URL,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  private async run(query: string, signal?: AbortSignal): Promise<OverpassElement[]> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      signal: signal ?? null,
    });
    if (!response.ok) throw new Error(`overpass ${response.status}`);
    const body = (await response.json()) as { elements?: OverpassElement[] };
    return body.elements ?? [];
  }

  async searchNearby(params: {
    lat: number;
    lng: number;
    radiusM: number;
    signal?: AbortSignal;
  }): Promise<ResolvedPoi[]> {
    const { lat, lng, radiusM, signal } = params;
    const query = `[out:json][timeout:8];nwr(around:${Math.min(radiusM, 500)},${lat},${lng})["name"];out tags center 30;`;
    const elements = await this.run(query, signal);
    const now = this.nowIso();
    return elements
      .map((el) => toPoi(el, now))
      .filter((poi): poi is ResolvedPoi => poi !== undefined);
  }

  async discover(
    bbox: BBox,
    opts?: { signal?: AbortSignal; limit?: number },
  ): Promise<DiscoverResult> {
    // Whole-country Overpass queries are abusive; enforce an area budget.
    if (bboxAreaKm2(bbox) > MAX_DISCOVER_AREA_KM2) return { pois: [], truncated: true };
    const limit = opts?.limit ?? DISCOVER_LIMIT;
    const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
    const query = `[out:json][timeout:8];(nwr["name"]["amenity"](${b});nwr["name"]["shop"](${b});nwr["name"]["tourism"](${b});nwr["name"]["leisure"](${b}););out tags center ${limit};`;
    const elements = await this.run(query, opts?.signal);
    const now = this.nowIso();
    const pois = elements
      .map((el) => toPoi(el, now))
      .filter((poi): poi is ResolvedPoi => poi !== undefined);
    return { pois, truncated: elements.length >= limit };
  }
}
