/**
 * The library as the filter sees it (spec/src/map-view.md §The library):
 * every place joined with its lists and with what the review classifier
 * derived about it. Review-derived tags stay a separate facet from the
 * owner's own tags all the way to the screen — they come from other people's
 * reviews and are never written onto the place.
 */
import {
  googleFeatureId,
  type Place,
  type PlaceFacets,
  type PlaceProfile,
  vocabLabel,
} from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useMemo } from "react";
import { usePlaceViews } from "../../data/hooks";
import type { PlaceView } from "../../data/repo";
import { insightsDb } from "../insights/db";

export interface DerivedFacts {
  /** Vocabulary keys, e.g. "date_night" — label with vocabLabel. */
  tags: string[];
  /** The summary and dish names, for free-text search. */
  text: string;
}

/** What a profile contributes to finding its place. */
export function derivedFromProfile(profile: PlaceProfile): DerivedFacts {
  return {
    tags: profile.tags.map((t) => t.tag),
    text: [
      profile.summary?.text,
      ...profile.dishes.map((d) => d.name),
      // The labels too, so "date night" finds the `date_night` tag.
      ...profile.tags.map((t) => vocabLabel(t.tag)),
      profile.price ? vocabLabel(profile.price.signal) : undefined,
    ]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(" \n "),
  };
}

/** placeId → derived facts, for every place that has a classified profile. */
export async function readDerivedIndex(
  places: readonly Pick<Place, "id" | "googleUrl">[],
): Promise<Map<string, DerivedFacts>> {
  const db = insightsDb();
  const [sources, profiles] = await Promise.all([
    db.placeSources.toArray(),
    db.placeProfiles.toArray(),
  ]);
  const index = new Map<string, DerivedFacts>();
  if (profiles.length === 0) return index;
  const profileByKey = new Map(profiles.map((p) => [p.sourcePlaceKey, p]));
  const keyByPlaceId = new Map(
    sources
      .filter((s) => s.placeId !== undefined)
      .map((s) => [s.placeId as string, s.sourcePlaceKey]),
  );
  for (const place of places) {
    const key =
      (place.googleUrl ? googleFeatureId(place.googleUrl) : undefined) ??
      keyByPlaceId.get(place.id);
    const profile = key
      ? (profileByKey.get(key) ?? profileByKey.get(keyByPlaceId.get(place.id) ?? ""))
      : undefined;
    if (profile) index.set(place.id, derivedFromProfile(profile));
  }
  return index;
}

const NO_TAGS: readonly string[] = [];

export function toFacets(
  views: readonly PlaceView[],
  derived: ReadonlyMap<string, DerivedFacts>,
): PlaceFacets[] {
  return views.map((view) => {
    const d = derived.get(view.place.id);
    return {
      place: view.place,
      listIds: view.listIds,
      derivedTags: d?.tags ?? NO_TAGS,
      ...(d?.text ? { derivedText: d.text } : {}),
    };
  });
}

/** Every library place with its facets; undefined while the library loads. */
export function useLibraryFacets(): PlaceFacets[] | undefined {
  const views = usePlaceViews();
  const derived = useLiveQuery(
    () => (views ? readDerivedIndex(views.map((v) => v.place)) : undefined),
    [views],
  );
  return useMemo(
    () => (views ? toFacets(views, derived ?? new Map()) : undefined),
    [views, derived],
  );
}
