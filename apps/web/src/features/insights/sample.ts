/**
 * Development sample data: a made-up classified profile and placeholder
 * photos, attachable to any library place so the card can be seen before a
 * real harvest exists. Dev builds only; labelled as sample everywhere it shows.
 */
import type { PlaceProfile } from "@placemarks/domain";
import { insightsDb } from "./db";

export const SAMPLE_CLASSIFIER = "sample:not-real-reviews";

export function sampleProfile(sourcePlaceKey: string, now: string): PlaceProfile {
  return {
    sourcePlaceKey,
    computedAt: now,
    reviewCount: 214,
    analysedCount: 214,
    usefulCount: 187,
    classifiers: [SAMPLE_CLASSIFIER],
    aspects: [
      { aspect: "food", score: 1.52, mentions: 151 },
      { aspect: "service", score: 0.71, mentions: 98 },
      { aspect: "value", score: 1.08, mentions: 64 },
      { aspect: "ambience", score: 1.31, mentions: 77 },
      { aspect: "wait", score: -0.62, mentions: 41 },
    ],
    dishes: [
      { name: "Pastel de nata", mentions: 58, score: 1.8, reviewIds: [] },
      { name: "Galão", mentions: 31, score: 1.3, reviewIds: [] },
      { name: "Tosta mista", mentions: 22, score: 1.1, reviewIds: [] },
      { name: "Bolo de arroz", mentions: 14, score: 1.4, reviewIds: [] },
      { name: "Espresso", mentions: 12, score: 0.9, reviewIds: [] },
    ],
    price: { signal: "cheap", mentions: 39 },
    tags: [
      { kind: "vibe", tag: "lively", mentions: 44 },
      { kind: "vibe", tag: "casual", mentions: 38 },
      { kind: "vibe", tag: "outdoor_seating", mentions: 29 },
      { kind: "occasion", tag: "quick_bite", mentions: 52 },
      { kind: "occasion", tag: "solo", mentions: 23 },
      { kind: "occasion", tag: "brunch", mentions: 19 },
      { kind: "dietary", tag: "vegetarian", mentions: 12 },
    ],
    warnings: [],
    practical: { reservationAdvised: 3, cashOnly: 0, medianWaitMinutes: 12 },
    summary: {
      text: "Reviewers come for the custard tarts, which most call the best in the neighbourhood, and pair them with a galão at the counter. Prices are low and the terrace fills quickly. The most common complaint is the queue at weekends, which can reach fifteen minutes.",
      claims: [],
      classifier: SAMPLE_CLASSIFIER,
      createdAt: now,
    },
  };
}

export async function attachSampleInsights(placeId: string, now: string): Promise<void> {
  const db = insightsDb();
  const key = `sample:${placeId}`;
  await db.transaction("rw", db.placeSources, db.photos, db.placeProfiles, async () => {
    await db.placeSources.put({
      sourcePlaceKey: key,
      placeId,
      rating: 4.6,
      ratingCount: 1284,
      priceLevel: 1,
      loadedAt: now,
    });
    await db.photos.where("sourcePlaceKey").equals(key).delete();
    await db.photos.bulkPut(
      [1, 2, 3, 4, 5, 6].map((n) => ({
        id: `${key}:${n}`,
        sourcePlaceKey: key,
        url: `/sample-insights/photo-${n}.jpg`,
        attribution: { name: "Sample photo" },
        source: "sample",
      })),
    );
    await db.placeProfiles.put(sampleProfile(key, now));
  });
}
