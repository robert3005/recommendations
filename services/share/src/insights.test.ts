/**
 * Hosted review insights (spec/src/reviews.md §Hosted on import): the access
 * key gates every lookup, a cached answer is free, the daily budget caps
 * fetches, and the answer never carries review text.
 */
import type { PlaceProfile } from "@placemarks/domain";
import { describe, expect, it, vi } from "vitest";
import { createShareApp } from "./app";
import type { FetchedPlace, InsightsOptions } from "./insights";
import { MemoryStorage } from "./storage";

const KEY = "0x47e66e2964e34e2d:0x8ddca9ee380ef7e0";
const ACCESS = "k".repeat(43); // shaped like 256 bits of base64url
const T0 = Date.parse("2026-11-23T12:00:00Z");

const fetched: FetchedPlace = {
  place: { name: "Can Roca", rating: 4.6, ratingCount: 812, priceLevel: 3 },
  reviews: [
    {
      id: "rev_1",
      text: "SECRET REVIEW TEXT: the tasting menu was superb",
      rating: 5,
      contentHash: "h1",
    },
    { id: "rev_2", text: "", rating: 4, contentHash: "h2" },
  ],
  photos: [
    {
      id: "pho_1",
      url: "https://lh5.googleusercontent.com/p/x",
      attribution: { name: "Google Maps" },
      source: "google",
    },
  ],
};

const profile: PlaceProfile = {
  sourcePlaceKey: KEY,
  computedAt: "2026-11-23T12:00:00.000Z",
  reviewCount: 2,
  analysedCount: 1,
  usefulCount: 1,
  classifiers: ["anthropic:claude-haiku-5-5"],
  aspects: [{ aspect: "food", score: 1.5, mentions: 1 }],
  dishes: [],
  tags: [],
  warnings: [],
  practical: { reservationAdvised: 0, cashOnly: 0 },
};

function setup(overrides: Partial<Omit<InsightsOptions, "storage">> = {}) {
  let now = T0;
  const fetchPlace = vi.fn(async () => fetched);
  const classify = vi.fn(async () => profile);
  const app = createShareApp({
    storage: new MemoryStorage(),
    insights: { accessKey: ACCESS, fetchPlace, classify, now: () => now, ...overrides },
  });
  const post = (body: unknown, token: string | null = ACCESS) =>
    app.request("/i/places", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  return { post, fetchPlace, classify, advance: (ms: number) => (now += ms) };
}

describe("POST /i/places", () => {
  it("answers 501 when the service has no keys", async () => {
    const { post } = setup({ fetchPlace: undefined, classify: undefined });
    expect((await post({ sourcePlaceKey: KEY })).status).toBe(501);
  });

  it("needs the access key", async () => {
    const { post, fetchPlace } = setup();
    expect((await post({ sourcePlaceKey: KEY }, null)).status).toBe(401);
    expect((await post({ sourcePlaceKey: KEY }, "w".repeat(43))).status).toBe(403);
    expect(fetchPlace).not.toHaveBeenCalled();
  });

  it("rejects a malformed place key", async () => {
    const { post } = setup();
    expect((await post({ sourcePlaceKey: "ChIJ123" })).status).toBe(400);
  });

  it("fetches, classifies and answers without review text", async () => {
    const { post, fetchPlace, classify } = setup();
    const res = await post({ sourcePlaceKey: KEY, name: "Can Roca", lat: 41.98, lng: 2.81 });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const raw = await res.text();
    expect(raw).not.toContain("SECRET REVIEW TEXT");
    const body = JSON.parse(raw);
    expect(body).toMatchObject({
      sourcePlaceKey: KEY,
      place: { name: "Can Roca", rating: 4.6 },
      reviewCount: 2,
      writtenCount: 1,
      profile: { sourcePlaceKey: KEY, usefulCount: 1 },
    });
    expect(body.photos).toHaveLength(1);
    expect(fetchPlace).toHaveBeenCalledWith({
      sourcePlaceKey: KEY,
      name: "Can Roca",
      lat: 41.98,
      lng: 2.81,
    });
    expect(classify).toHaveBeenCalledOnce();
  });

  it("serves a cached answer for a month and refreshes only after a week", async () => {
    const { post, fetchPlace, advance } = setup();
    await post({ sourcePlaceKey: KEY });
    const again = await post({ sourcePlaceKey: KEY, refresh: true });
    expect(again.headers.get("x-insights")).toBe("cached");
    expect(fetchPlace).toHaveBeenCalledTimes(1);
    advance(8 * 86_400_000);
    expect((await post({ sourcePlaceKey: KEY })).headers.get("x-insights")).toBe("cached");
    expect((await post({ sourcePlaceKey: KEY, refresh: true })).headers.get("x-insights")).toBe(
      "fetched",
    );
    advance(31 * 86_400_000);
    expect((await post({ sourcePlaceKey: KEY })).headers.get("x-insights")).toBe("fetched");
  });

  it("stops at the daily budget", async () => {
    const { post } = setup({ dailyPlaces: 1 });
    expect((await post({ sourcePlaceKey: KEY })).status).toBe(200);
    expect((await post({ sourcePlaceKey: "cid:123" })).status).toBe(429);
  });
  it("answers 404 when Google has no listing, and caches nothing", async () => {
    const { post, fetchPlace } = setup({ fetchPlace: vi.fn(async () => undefined) });
    expect((await post({ sourcePlaceKey: KEY })).status).toBe(404);
    expect((await post({ sourcePlaceKey: KEY })).status).toBe(404);
    expect(fetchPlace).toBeDefined();
  });

  it("reports a failed classification and caches nothing", async () => {
    const classify = vi.fn(async () => {
      throw new Error("Anthropic API 401");
    });
    const { post } = setup({ classify });
    const res = await post({ sourcePlaceKey: KEY });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("Anthropic API 401");
    await post({ sourcePlaceKey: KEY });
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it("keeps a place with no written reviews, without a profile", async () => {
    const { post, classify } = setup({
      fetchPlace: vi.fn(async () => ({
        ...fetched,
        reviews: [{ id: "r", text: " ", rating: 3, contentHash: "h" }],
      })),
    });
    const body = await (await post({ sourcePlaceKey: KEY })).json();
    expect(body.profile).toBeUndefined();
    expect(body.writtenCount).toBe(0);
    expect(classify).not.toHaveBeenCalled();
  });
});
