/**
 * Overpass adapter for area queries: nearby candidates (long-press picker, identity
 * recovery) and bounded viewport discovery. Budgets per spec/src/data-sources.md.
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
  /** In-flight viewport queries coalesce; identical empty responses cache. */
  private readonly inflight = new Map<string, Promise<DiscoverResult>>();
  private readonly emptyCache = new Map<string, { at: number; result: DiscoverResult }>();

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
    const key = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}|${limit.toString()}`;
    // An identical empty viewport answered moments ago answers again for free.
    const cachedEmpty = this.emptyCache.get(key);
    if (cachedEmpty && Date.now() - cachedEmpty.at < 5 * 60_000) return cachedEmpty.result;
    // Concurrent identical viewport requests share one upstream query.
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const request = (async () => {
      const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
      const query = `[out:json][timeout:8];(nwr["name"]["amenity"](${b});nwr["name"]["shop"](${b});nwr["name"]["tourism"](${b});nwr["name"]["leisure"](${b}););out tags center ${limit.toString()};`;
      const elements = await this.run(query, opts?.signal);
      const now = this.nowIso();
      const pois = elements
        .map((el) => toPoi(el, now))
        .filter((poi): poi is ResolvedPoi => poi !== undefined)
        // The application budget binds even when the upstream ignores the cap.
        .slice(0, limit);
      const result: DiscoverResult = { pois, truncated: elements.length >= limit };
      if (pois.length === 0 && elements.length === 0) {
        if (this.emptyCache.size >= 50) this.emptyCache.clear();
        this.emptyCache.set(key, { at: Date.now(), result });
      }
      return result;
    })();
    this.inflight.set(key, request);
    try {
      return await request;
    } finally {
      this.inflight.delete(key);
    }
  }
}
