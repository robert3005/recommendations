/**
 * Post-add place enrichment (spec/src/data-model.md §Normative rules): one
 * exact OSM lookup fills a place's MISSING facts — never overwriting anything
 * the user can already see — and, when the element names a Wikipedia article
 * and a description or photo is still missing, one REST summary call fills
 * description (descriptionSource "wikipedia"), wikipediaUrl, and the image
 * fallback. All of it is best-effort and silent: a failure or being offline
 * changes nothing, and nothing queues.
 */
import type { GeocoderCandidate, OsmRef, Place } from "@placemarks/domain";
import type { LocalRepository, PlaceFactsPatch } from "../../data/repo";
import { wikipediaSummary } from "../../providers/wikipedia";

/** The published description cap — OSM description tags obey it too. */
const DESCRIPTION_MAX_CHARS = 600;

/** One attempt per place per session, successful or not — enrichment never nags a provider. */
const attempted = new Set<string>();

/** Test seam: forget this session's attempts. */
export function resetEnrichmentAttempts(): void {
  attempted.clear();
}

type EnrichmentRepo = Pick<LocalRepository, "updatePlaceFacts">;
type EnrichmentGeocoder = {
  lookup(ref: OsmRef, opts?: { signal?: AbortSignal }): Promise<GeocoderCandidate | undefined>;
};

export async function enrichPlace(
  repo: EnrichmentRepo,
  geocoder: EnrichmentGeocoder,
  place: Place,
): Promise<void> {
  if (!place.osmRef) return; // nothing to look up — manual pins stay untouched
  if (attempted.has(place.id)) return;
  attempted.add(place.id);
  try {
    const candidate = await geocoder.lookup(place.osmRef);
    if (!candidate) return;

    // OSM tags first: fill exactly the fields the place is missing.
    const patch: PlaceFactsPatch = {};
    const fill = <K extends keyof PlaceFactsPatch & keyof GeocoderCandidate>(key: K) => {
      if (place[key] === undefined && candidate[key] !== undefined) {
        patch[key] = candidate[key] as PlaceFactsPatch[K];
      }
    };
    fill("address");
    fill("imageUrl");
    fill("website");
    fill("phone");
    fill("openingHours");
    fill("cuisine");
    fill("wheelchair");
    if (place.description === undefined && candidate.description !== undefined) {
      patch.description = candidate.description.slice(0, DESCRIPTION_MAX_CHARS);
      patch.descriptionSource = "osm";
    }

    // Wikipedia is the fallback, consulted only when the element names an
    // article and a description or photo is still missing after the tags.
    const missingDescription = place.description === undefined && patch.description === undefined;
    const missingImage = place.imageUrl === undefined && patch.imageUrl === undefined;
    if (candidate.wikipedia !== undefined && (missingDescription || missingImage)) {
      const summary = await wikipediaSummary(candidate.wikipedia);
      if (summary) {
        if (missingDescription && summary.extract !== undefined) {
          patch.description = summary.extract;
          patch.descriptionSource = "wikipedia";
        }
        if (missingImage && summary.thumbnailUrl !== undefined) {
          patch.imageUrl = summary.thumbnailUrl;
        }
        if (place.wikipediaUrl === undefined && summary.articleUrl !== undefined) {
          patch.wikipediaUrl = summary.articleUrl;
        }
      }
    }

    if (Object.keys(patch).length > 0) await repo.updatePlaceFacts(place.id, patch);
  } catch {
    // Silent by design: enrichment never surfaces an error.
  }
}
