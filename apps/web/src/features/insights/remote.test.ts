/**
 * Hosted review insights in the browser (spec/src/reviews.md §Hosted on
 * import): the access key stays on the device, an answer lands in the
 * insights store, and the queue stops on an answer that would fail every
 * place the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsDb, setInsightsDb } from "./db";
import { readPlaceInsights } from "./hooks";
import {
  fetchPlaceInsights,
  placesMissingInsights,
  queueInsights,
  resetInsightsQueue,
  saveAccessKey,
} from "./remote";
import { sampleProfile } from "./sample";

const NOW = "2026-11-23T12:00:00.000Z";
const KEY = "0x47e66e2964e34e2d:0x8ddca9ee380ef7e0";
const place = {
  id: "p1",
  name: "Can Roca",
  lat: 41.98,
  lng: 2.81,
  googleUrl: `https://www.google.com/maps/place/data=!4m2!3m1!1s${KEY}`,
};

const payload = {
  sourcePlaceKey: KEY,
  fetchedAt: NOW,
  place: { name: "Can Roca", rating: 4.6, ratingCount: 812 },
  photos: [
    {
      id: "a",
      url: "https://lh5.googleusercontent.com/p/a",
      attribution: { name: "G" },
      source: "google",
    },
    { id: "b", url: "javascript:alert(1)", attribution: { name: "G" }, source: "google" },
  ],
  reviewCount: 40,
  writtenCount: 31,
  profile: sampleProfile(KEY, NOW),
};

let db: InsightsDb;
beforeEach(() => {
  db = new InsightsDb(`test-${Math.random()}`);
  setInsightsDb(db);
  resetInsightsQueue();
  saveAccessKey("k".repeat(43));
});
afterEach(() => {
  saveAccessKey("");
  vi.unstubAllGlobals();
});

describe("fetchPlaceInsights", () => {
  it("sends the place and the key, and stores the answer for the card", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await fetchPlaceInsights(place, { now: NOW, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/i\/places$/);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${"k".repeat(43)}`);
    expect(JSON.parse(String(init.body))).toEqual({
      sourcePlaceKey: KEY,
      name: "Can Roca",
      lat: 41.98,
      lng: 2.81,
    });
    const insights = await readPlaceInsights(place);
    expect(insights?.source).toMatchObject({ origin: "service", rating: 4.6, writtenCount: 31 });
    expect(insights?.profile?.usefulCount).toBe(payload.profile.usefulCount);
    expect(insights?.photos.map((p) => p.id)).toEqual(["a"]);
    expect(await placesMissingInsights([place])).toEqual([]);
  });

  it("names a wrong key plainly", async () => {
    const fetchImpl = vi.fn(async () => new Response("wrong access key", { status: 403 }));
    await expect(fetchPlaceInsights(place, { now: NOW, fetchImpl })).rejects.toThrow(
      "access key is wrong",
    );
  });
});

describe("the queue", () => {
  it("does nothing without an access key", () => {
    saveAccessKey("");
    expect(queueInsights([place], () => NOW)).toBe(0);
  });

  it("stops at the first answer that would fail every place", async () => {
    const fetchMock = vi.fn(async () => new Response("budget used up", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const places = [1, 2, 3, 4, 5].map((n) => ({
      ...place,
      googleUrl: `https://maps.google.com/?cid=${n}`,
    }));
    expect(queueInsights(places, () => NOW)).toBe(5);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    // Two workers start; neither takes a third place after the stop.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
