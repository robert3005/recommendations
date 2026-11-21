import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harvestPhotoSchema, harvestReviewSchema } from "@placemarks/schemas";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Fetch,
  llParam,
  normalizeSerpReview,
  type SerpPlace,
  serpApiProvider,
} from "./serpapi";
import type { HarvestOptions } from "./types";

const DATA_ID = "0x89c2598f7ff4aa09:0x313547e757cb8cea";
const katz: SerpPlace = {
  title: "Katz's Delicatessen",
  place_id: "ChIJCar0f49ZwokR6ozLV-dHNTE",
  data_id: DATA_ID,
  data_cid: "3545819340560108778",
  gps_coordinates: { latitude: 40.7222, longitude: -73.9874 },
  address: "205 E Houston St, New York, NY 10002",
  rating: 4.5,
  reviews: 3,
  price: "$$",
  type: "Deli",
  types: ["Deli", "Jewish restaurant"],
  operating_hours: { monday: "8 AM–11 PM", tuesday: "8 AM–11 PM" },
  rating_summary: [
    { stars: 5, amount: 2 },
    { stars: 1, amount: 1 },
  ],
  images: [{ title: "Menu", thumbnail: "https://lh5.googleusercontent.com/p/menu" }],
};

const review = (id: string, text: string, rating = 5) => ({
  review_id: id,
  rating,
  date: "a week ago",
  iso_date: "2026-11-08T17:14:53Z",
  snippet: text,
  extracted_snippet: { original: text },
  likes: 2,
  user: { name: `User ${id}`, link: `https://www.google.com/maps/contrib/${id}` },
  images: ["https://lh5.googleusercontent.com/p/r" + id],
});

/** Records every request and answers from a routing function. */
function fakeFetch(route: (params: URLSearchParams) => unknown) {
  const requests: URLSearchParams[] = [];
  const fetchImpl: Fetch = async (url) => {
    const params = new URL(url).searchParams;
    requests.push(params);
    const body = route(params);
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, requests };
}

let options: HarvestOptions;
beforeEach(async () => {
  options = {
    extraReviews: true,
    depth: 1,
    language: "en",
    workDir: await mkdtemp(path.join(os.tmpdir(), "serp-")),
  };
});

describe("SerpApi provider", () => {
  it("looks a URL up by data id + coordinates and pages reviews to the end", async () => {
    const { fetchImpl, requests } = fakeFetch((p) => {
      if (p.get("engine") === "google_maps") return { place_results: katz };
      if (!p.get("next_page_token")) {
        return {
          reviews: [review("a", "Huge sandwich"), review("b", "Loud")],
          serpapi_pagination: { next_page_token: "t1" },
        };
      }
      return { reviews: [review("c", "Worth it", 4)] };
    });
    const provider = serpApiProvider({ apiKey: "k", maxReviews: 50, fetch: fetchImpl });
    const url = `https://www.google.com/maps/place/Katz's/@40.72,-73.98,17z/data=!3m1!4b1!4m6!3m5!1s${DATA_ID}!8m2!3d40.7222!4d-73.9874`;
    const result = await provider.harvest([{ query: url, kind: "url" }], options);

    expect(requests[0]?.get("type")).toBe("place");
    expect(requests[0]?.get("data")).toBe(`!4m5!3m4!1s${DATA_ID}!8m2!3d40.7222!4d-73.9874`);
    expect(requests[0]?.get("api_key")).toBe("k");
    expect(requests[1]?.get("sort_by")).toBe("newestFirst");
    expect(requests[1]?.has("num")).toBe(false);
    expect(requests[2]?.get("next_page_token")).toBe("t1");
    expect(requests[2]?.get("num")).toBe("20");

    const harvested = result.places[0];
    expect(harvested?.reviews).toHaveLength(3);
    expect(harvested?.place).toMatchObject({
      sourcePlaceKey: DATA_ID,
      googlePlaceId: "ChIJCar0f49ZwokR6ozLV-dHNTE",
      name: "Katz's Delicatessen",
      ratingCount: 3,
      priceLevel: 2,
      types: ["Deli", "Jewish restaurant"],
      openingHours: ["Monday: 8 AM–11 PM", "Tuesday: 8 AM–11 PM"],
      ratingHistogram: { "5": 2, "1": 1 },
      reviewCollection: { status: "complete", collected: 3, expected: 3 },
      provider: "serpapi",
    });
    for (const r of harvested?.reviews ?? []) harvestReviewSchema.parse(r);
    for (const p of harvested?.photos ?? []) harvestPhotoSchema.parse(p);
    expect(harvested?.photos).toHaveLength(4); // 3 review photos + 1 place photo
  });

  it("stops paging at maxReviews and marks the download partial", async () => {
    const { fetchImpl, requests } = fakeFetch((p) =>
      p.get("engine") === "google_maps"
        ? { place_results: { ...katz, reviews: 500 } }
        : {
            reviews: [review(`r${requests.length}`, "x"), review(`s${requests.length}`, "y")],
            serpapi_pagination: { next_page_token: "more" },
          },
    );
    const provider = serpApiProvider({ apiKey: "k", maxReviews: 3, fetch: fetchImpl });
    const result = await provider.harvest(
      [
        {
          query: `https://www.google.com/maps/place/K/data=!1s${DATA_ID}!3d40.7!4d-73.9`,
          kind: "url",
        },
      ],
      options,
    );
    expect(requests).toHaveLength(3); // place + 2 review pages
    expect(result.places[0]?.reviews).toHaveLength(3);
    expect(result.places[0]?.place.reviewCollection).toMatchObject({
      status: "partial",
      collected: 3,
      expected: 500,
      reason: "stopped at --max-reviews",
    });
  });

  it("searches without coordinates and picks the listing whose data id matches", async () => {
    const other = { ...katz, data_id: "0x1:0x2", title: "Other" };
    const { fetchImpl, requests } = fakeFetch((p) =>
      p.get("engine") === "google_maps" ? { local_results: [other, katz] } : { reviews: [] },
    );
    const provider = serpApiProvider({ apiKey: "k", maxReviews: 10, fetch: fetchImpl });
    const result = await provider.harvest(
      [
        {
          query: "https://www.google.com/maps/search/Katz's+Delicatessen+New+York",
          kind: "url",
          title: "Katz's",
        },
      ],
      options,
    );
    expect(requests[0]?.get("type")).toBe("search");
    expect(requests[0]?.get("q")).toBe("Katz's Delicatessen New York");
    expect(result.places.map((p) => p.place.name)).toEqual(["Other"]); // no id to match: top result
  });

  it("returns every result for a search and skips reviews when asked", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({
      local_results: [katz, { ...katz, data_id: "0x1:0x2", title: "Second" }],
    }));
    const provider = serpApiProvider({ apiKey: "k", maxReviews: 10, fetch: fetchImpl });
    const result = await provider.harvest([{ query: "deli", kind: "search" }], {
      ...options,
      extraReviews: false,
      area: { geo: { lat: 40.72, lng: -73.98 }, radiusMeters: 500 },
    });
    expect(result.places).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get("ll")).toBe("@40.72,-73.98,1000m");
  });

  it("accepts place results whose type is a list, and reuses cached responses on a re-run", async () => {
    const { fetchImpl, requests } = fakeFetch((p) =>
      p.get("engine") === "google_maps"
        ? {
            place_results: {
              ...katz,
              type: ["Deli", "Sandwich shop"],
              types: undefined,
              title: "  Katz's  ",
            },
          }
        : { reviews: [review("a", "Good")] },
    );
    const provider = serpApiProvider({ apiKey: "k", maxReviews: 10, fetch: fetchImpl });
    const input = [
      {
        query: `https://www.google.com/maps/place/K/data=!1s${DATA_ID}!3d40.7!4d-73.9`,
        kind: "url" as const,
      },
    ];
    const first = await provider.harvest(input, options);
    expect(first.failures).toEqual([]);
    expect(first.places[0]?.place).toMatchObject({
      name: "Katz's",
      types: ["Deli", "Sandwich shop"],
    });
    expect(requests).toHaveLength(2);
    await provider.harvest(input, options);
    expect(requests).toHaveLength(2); // served from the on-disk cache: no new credits
  });

  it("records a per-input failure, but throws on an auth or quota error", async () => {
    const bad = fakeFetch(() => ({ error: "Invalid API key. Your API key should be here" }));
    await expect(
      serpApiProvider({ apiKey: "k", maxReviews: 5, fetch: bad.fetchImpl }).harvest(
        [{ query: "deli", kind: "search" }],
        options,
      ),
    ).rejects.toThrow(/Invalid API key/);

    const empty = fakeFetch(() => ({
      error: "Google hasn't returned any results for this query.",
    }));
    const result = await serpApiProvider({
      apiKey: "k",
      maxReviews: 5,
      fetch: empty.fetchImpl,
    }).harvest([{ query: "nothing here", kind: "search" }], options);
    expect(result).toEqual({ places: [], failures: [] });
  });
});

describe("SerpApi normalization", () => {
  it("keeps translations and owner replies, and drops reviews with nothing in them", () => {
    const normalized = normalizeSerpReview(
      {
        review_id: "x",
        rating: 3,
        extracted_snippet: { original: "Gut, aber laut.", translated: "Good, but loud." },
        response: { snippet: "Danke!", iso_date: "2026-11-09T10:00:00Z" },
      },
      DATA_ID,
      "2026-11-21T00:00:00.000Z",
    );
    expect(normalized?.review).toMatchObject({
      text: "Gut, aber laut.",
      translatedText: "Good, but loud.",
      ownerResponse: { text: "Danke!", publishedAt: "2026-11-09T10:00:00.000Z" },
    });
    expect(
      normalizeSerpReview({ review_id: "y" }, DATA_ID, "2026-11-21T00:00:00.000Z"),
    ).toBeUndefined();
  });

  it("turns a search area into an ll map height", () => {
    expect(llParam(undefined)).toBeUndefined();
    expect(llParam({ bbox: [51.5, -0.1, 51.6, 0] })).toBe("@51.55,-0.05,11132m");
  });
});
