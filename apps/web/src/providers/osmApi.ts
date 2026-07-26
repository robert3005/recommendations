/**
 * Exact OSM element lookup via the OSM API 0.6 (spec/src/data-sources.md
 * §Geocoder): serves OSM element URL paste. A definitive 404/410 means the
 * element does not exist — `undefined`. Every other failure throws:
 * unavailability fails politely, nothing queues, the user retries online
 * (spec/src/storage.md §Offline behaviour).
 */
import type { GeocoderCandidate, OsmRef } from "@placemarks/domain";
import { OSM_API_URL } from "../config";

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
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

const WIKIMEDIA_HOSTS = new Set(["commons.wikimedia.org", "upload.wikimedia.org"]);

/**
 * A place photo comes only from the element's tags, and only Wikimedia-hosted
 * (spec/src/data-model.md §Normative rules): the CSP stays tight and the
 * credit link is a licensing click-through. An `image` tag is accepted as-is
 * when its host is Wikimedia; a `wikimedia_commons` `File:` tag maps to the
 * Special:FilePath thumbnail URL. Anything else is ignored.
 */
function imageUrlOf(tags: Record<string, string>): string | undefined {
  const image = tags.image;
  if (image !== undefined) {
    try {
      const url = new URL(image);
      if (url.protocol === "https:" && WIKIMEDIA_HOSTS.has(url.hostname)) return image;
    } catch {
      // not an absolute URL — fall through to wikimedia_commons
    }
  }
  const commons = tags.wikimedia_commons;
  if (commons?.startsWith("File:")) {
    const name = encodeURIComponent(commons.slice("File:".length));
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${name}?width=640`;
  }
  return undefined;
}

/** Website from website | contact:website | url — https only; anything else is dropped. */
function websiteOf(tags: Record<string, string>): string | undefined {
  for (const key of ["website", "contact:website", "url"]) {
    const value = tags[key];
    if (value?.startsWith("https://")) return value;
  }
  return undefined;
}

const WHEELCHAIR_VALUES = new Set(["yes", "limited", "no"]);

/**
 * Richer POI facts from the element's tags (spec/src/data-model.md §Normative
 * rules): captured opportunistically at lookup, filled onto places only while
 * missing. `wikipedia` is the raw tag value ("lang:Article Title") for the
 * summary provider to resolve.
 */
function poiFactsOf(tags: Record<string, string>): Partial<GeocoderCandidate> {
  const website = websiteOf(tags);
  const phone = tags.phone ?? tags["contact:phone"];
  const wheelchair = tags.wheelchair;
  return {
    ...(website !== undefined ? { website } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(tags.opening_hours !== undefined ? { openingHours: tags.opening_hours } : {}),
    ...(tags.cuisine !== undefined ? { cuisine: tags.cuisine } : {}),
    ...(wheelchair !== undefined && WHEELCHAIR_VALUES.has(wheelchair) ? { wheelchair } : {}),
    ...(tags.description !== undefined ? { description: tags.description } : {}),
    ...(tags.wikipedia !== undefined ? { wikipedia: tags.wikipedia } : {}),
  };
}

function addressOf(tags: Record<string, string>): string | undefined {
  const address = [
    [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" "),
    [tags["addr:city"], tags["addr:postcode"]].filter(Boolean).join(" "),
  ]
    .filter((part) => part !== "")
    .join(", ");
  return address || undefined;
}

export class OsmApiGeocoder {
  constructor(private readonly baseUrl: string = OSM_API_URL) {}

  async lookup(
    ref: OsmRef,
    opts?: { signal?: AbortSignal },
  ): Promise<GeocoderCandidate | undefined> {
    const path =
      ref.type === "node"
        ? `/api/0.6/node/${ref.id}.json`
        : `/api/0.6/${ref.type}/${ref.id}/full.json`;
    const response = await fetch(`${this.baseUrl}${path}`, { signal: opts?.signal ?? null });
    // 404 (never existed / not current) and 410 (deleted) are definitive.
    if (response.status === 404 || response.status === 410) return undefined;
    if (!response.ok) throw new Error(`osm api ${response.status}`);
    const body = (await response.json()) as { elements?: OsmElement[] };
    const elements = body.elements ?? [];
    const target = elements.find((el) => el.type === ref.type && String(el.id) === ref.id);
    // A successful response without the requested element is malformed
    // provider output — unavailability, never a definitive disappearance.
    if (!target) throw new Error("osm api: element missing from response");
    const point = representativePoint(target, elements);
    if (!point) throw new Error("osm api: element carries no coordinates");
    const tags = target.tags ?? {};
    const address = addressOf(tags);
    const imageUrl = imageUrlOf(tags);
    return {
      name: tags.name ?? tags["name:en"] ?? `${ref.type}/${ref.id}`,
      lat: point.lat,
      lng: point.lng,
      ...(address ? { address } : {}),
      osmRef: ref,
      ...(imageUrl ? { imageUrl } : {}),
      ...poiFactsOf(tags),
    };
  }
}
