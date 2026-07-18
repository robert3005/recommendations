/**
 * Exact OSM element resolution via the OSM API 0.6 (book/src/tech-stack.md:
 * per-element reads at save/refresh volume; Overpass handles area queries).
 *
 * Outcome mapping is the identity-critical part (book/src/place-identity.md):
 * only a definitive 404/410 is `gone`; every other failure is `error`
 * (unavailability), which must never trigger relinking.
 */
import {
  type ExactOutcome,
  type OsmElementRef,
  type ResolvedPoi,
  resolvedPoiFromTags,
} from "@placemarks/domain";
import { OSM_API_URL } from "../config";

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  version?: number;
  tags?: Record<string, string>;
  nodes?: number[];
}

function representativePoint(
  target: OsmElement,
  elements: OsmElement[],
): { lat: number; lng: number } | undefined {
  if (target.lat !== undefined && target.lon !== undefined) {
    return { lat: target.lat, lng: target.lon };
  }
  const coords = elements.filter(
    (el) => el.type === "node" && el.lat !== undefined && el.lon !== undefined,
  );
  if (coords.length === 0) return undefined;
  const capped = coords.slice(0, 200);
  const lat = capped.reduce((sum, el) => sum + (el.lat ?? 0), 0) / capped.length;
  const lng = capped.reduce((sum, el) => sum + (el.lon ?? 0), 0) / capped.length;
  return { lat, lng };
}

export class OsmApiResolver {
  constructor(
    private readonly baseUrl: string = OSM_API_URL,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  async resolveExact(ref: OsmElementRef, opts?: { signal?: AbortSignal }): Promise<ExactOutcome> {
    const path =
      ref.type === "node"
        ? `/api/0.6/node/${ref.id}.json`
        : `/api/0.6/${ref.type}/${ref.id}/full.json`;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { signal: opts?.signal ?? null });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      return { type: "error" };
    }
    // 404 (never existed / not current) and 410 (deleted) are definitive.
    if (response.status === 404 || response.status === 410) return { type: "gone" };
    if (!response.ok) return { type: "error" };
    let body: { elements?: OsmElement[] };
    try {
      body = (await response.json()) as { elements?: OsmElement[] };
    } catch {
      return { type: "error" };
    }
    const elements = body.elements ?? [];
    const target = elements.find((el) => el.type === ref.type && String(el.id) === ref.id);
    if (!target) return { type: "gone" };
    const point = representativePoint(target, elements);
    if (!point) return { type: "error" };
    const poi: ResolvedPoi = resolvedPoiFromTags({
      ref,
      tags: target.tags ?? {},
      lat: point.lat,
      lng: point.lng,
      ...(target.version !== undefined ? { osmVersion: target.version } : {}),
      resolvedAt: this.nowIso(),
    });
    return { type: "ok", poi };
  }
}
