/**
 * Reactive reads of the insights store for one library place. A place joins
 * its insights by the Google feature id parsed from its `googleUrl` (the
 * harvest's sourcePlaceKey), or directly by placeId for attached sample data.
 */
import { googleFeatureId, type Place } from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo } from "react";
import { insightsDb, type PhotoRow, type PlaceSourceRow, type ProfileRow } from "./db";

export interface PlaceInsights {
  source?: PlaceSourceRow;
  profile?: ProfileRow;
  photos: PhotoRow[];
}

export function placeSourceKey(place: Pick<Place, "googleUrl">): string | undefined {
  return place.googleUrl ? googleFeatureId(place.googleUrl) : undefined;
}

export async function readPlaceInsights(
  place: Pick<Place, "id" | "googleUrl">,
): Promise<PlaceInsights | null> {
  const db = insightsDb();
  const key = placeSourceKey(place);
  const source =
    (key ? await db.placeSources.get(key) : undefined) ??
    (await db.placeSources.where("placeId").equals(place.id).first());
  const sourcePlaceKey = source?.sourcePlaceKey ?? key;
  if (!sourcePlaceKey) return null;
  const [profile, photos] = await Promise.all([
    db.placeProfiles.get(sourcePlaceKey),
    db.photos.where("sourcePlaceKey").equals(sourcePlaceKey).toArray(),
  ]);
  if (!source && !profile && photos.length === 0) return null;
  return { source, profile, photos };
}

/** undefined while loading, null when the place has no insights. */
export function usePlaceInsights(
  place: Pick<Place, "id" | "googleUrl"> | undefined,
): PlaceInsights | null | undefined {
  return useLiveQuery(
    () => (place ? readPlaceInsights(place) : Promise.resolve(null)),
    [place?.id, place?.googleUrl],
  );
}

/** Object URLs for locally loaded photos, revoked when the set changes. */
export function usePhotoUrls(photos: PhotoRow[]): Map<string, string> {
  const urls = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of photos) m.set(p.id, p.blob ? URL.createObjectURL(p.blob) : p.url);
    return m;
  }, [photos]);
  useEffect(
    () => () => {
      for (const p of photos) if (p.blob) URL.revokeObjectURL(urls.get(p.id) ?? "");
    },
    [photos, urls],
  );
  return urls;
}
